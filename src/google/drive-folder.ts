import { DriveAmbiguousPathError } from "../errors/drive-ambiguous-path-error.ts";
import { DriveApiError } from "../errors/drive-api-error.ts";
import { DriveScopeError } from "../errors/drive-scope-error.ts";
import type { GoogleOAuth } from "./oauth.ts";

export type DriveSpace = "appDataFolder" | "drive";

export interface GoogleDriveFolderConfig {
  oauth: GoogleOAuth;
  space: DriveSpace;
  rootFolderPath: string;
}

export type DriveFileEntry = {
  id: string;
  name: string;
  createdTime: string;
  mimeType: string;
};

type DriveContext = Pick<GoogleDriveFolderConfig, "oauth" | "space">;

const METADATA_OPERATIONS_ENDPOINT = "https://www.googleapis.com/drive/v3";
const UPLOAD_OPERATION_ENDPOINT = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

const APPDATA_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

const SPACE_SCOPES: Record<DriveSpace, readonly string[]> = {
  appDataFolder: [APPDATA_SCOPE],
  drive: [DRIVE_FILE_SCOPE],
};

export class GoogleDriveFolder {
  private readonly ctx: DriveContext;
  private rootFolderId!: string;
  private pathToFolderIdMap!: Map<string, string>;

  private constructor(config: GoogleDriveFolderConfig) {
    this.ctx = { oauth: config.oauth, space: config.space };
  }

  public static async getFolderHandle(
    config: GoogleDriveFolderConfig,
  ): Promise<GoogleDriveFolder> {
    const folder = new GoogleDriveFolder(config);
    folder.assertSpaceScope();
    await folder.resolveRootFolder(config.rootFolderPath);
    return folder;
  }

  public async files(subpath = ""): Promise<DriveFileEntry[]> {
    const parentFolderId = await this.folderIdForPath(subpath, false);
    const query = `'${parentFolderId}' in parents and trashed=false`;
    const entries = await this.queryFiles(query);
    return entries.filter((entry) => entry.mimeType !== FOLDER_MIME_TYPE);
  }

  public async read(relativePath: string): Promise<Blob> {
    const { parentFolderId, name } = await this.splitPath(relativePath, false);
    const file = await this.findFileInParent(parentFolderId, name);
    return (
      await this.driveRequest(
        METADATA_OPERATIONS_ENDPOINT,
        `/files/${file.id}?alt=media`,
      )
    ).blob();
  }

  public async write(
    relativePath: string,
    fileBlob: Blob,
    mimeType: string,
  ): Promise<DriveFileEntry> {
    const { parentFolderId, name } = await this.splitPath(relativePath, true);
    const body = this.encodeMultipart(name, parentFolderId, mimeType, fileBlob);
    const response = await this.driveRequest(
      UPLOAD_OPERATION_ENDPOINT,
      "/files?uploadType=multipart&fields=id,name,createdTime,mimeType",
      { method: "POST", body },
    );
    return (await response.json()) as DriveFileEntry;
  }

  public async exists(relativePath: string): Promise<boolean> {
    const segments = this.normalizePath(relativePath);
    if (segments.length === 0) return true;

    const fileName = segments.at(-1)!;
    const parentPath = segments.slice(0, -1).join("/");

    try {
      const parentFolderId = await this.folderIdForPath(parentPath, false);
      const escapedName = fileName.replace(/'/g, "\\'");
      const query = `name='${escapedName}' and '${parentFolderId}' in parents and trashed=false`;
      const matches = await this.queryFiles(query);
      return matches.length > 0;
    } catch {
      return false;
    }
  }

  public async mkdir(relativePath: string): Promise<void> {
    await this.folderIdForPath(relativePath, true);
  }

  public async deleteById(fileId: string): Promise<void> {
    await this.driveRequest(
      METADATA_OPERATIONS_ENDPOINT,
      `/files/${fileId}`,
      { method: "DELETE" },
    );
  }

  public async deleteByPath(relativePath: string): Promise<void> {
    const { parentFolderId, name } = await this.splitPath(relativePath, false);
    const file = await this.findFileInParent(parentFolderId, name);
    await this.deleteById(file.id);
  }

  private async folderIdForPath(
    subpath: string,
    createMissing: boolean,
  ): Promise<string> {
    const segments = this.normalizePath(subpath);
    if (segments.length === 0) return this.rootFolderId;

    const folderPath = segments.join("/");
    const cachedFolderId = this.pathToFolderIdMap.get(folderPath);
    if (cachedFolderId) return cachedFolderId;

    return this.walkFolderPath(this.rootFolderId, segments, createMissing);
  }

  private async splitPath(
    relativePath: string,
    createParents: boolean,
  ): Promise<{
    parentFolderId: string;
    name: string;
  }> {
    const segments = this.normalizePath(relativePath);
    if (segments.length === 0) {
      throw new Error("File path must include a file name");
    }

    const name = segments.at(-1)!;
    const parentPath = segments.slice(0, -1).join("/");
    return {
      parentFolderId: await this.folderIdForPath(parentPath, createParents),
      name,
    };
  }

  private async findFileInParent(
    parentFolderId: string,
    fileName: string,
  ): Promise<DriveFileEntry> {
    const escapedName = fileName.replace(/'/g, "\\'");
    const query = `name='${escapedName}' and '${parentFolderId}' in parents and trashed=false`;
    const matches = await this.queryFiles(query);
    const file = matches.find((entry) => entry.mimeType !== FOLDER_MIME_TYPE);
    if (!file) {
      throw new DriveApiError(`File not found: ${fileName}`, 404, "notFound");
    }
    return file;
  }

  private encodeMultipart(
    fileName: string,
    parentFolderId: string,
    mimeType: string,
    fileBlob: Blob,
  ): Blob {
    const boundary = `drive_socket_${crypto.randomUUID()}`;
    const filePart = {
      name: fileName,
      parents: [parentFolderId],
      mimeType,
    };
    const metaPart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(filePart)}\r\n`;
    const filePartHeader = `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`;
    const closing = `\r\n--${boundary}--`;

    return new Blob([metaPart, filePartHeader, fileBlob, closing], {
      type: `multipart/related; boundary=${boundary}`,
    });
  }

  private normalizePath(path: string): string[] {
    return path
      .split("/")
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
  }

  private assertSpaceScope(): void {
    const configuredScopes = new Set(
      this.ctx.oauth.getConfiguredScopes().split(/\s+/).filter(Boolean),
    );
    const requiredScopes = SPACE_SCOPES[this.ctx.space];
    const hasScope = requiredScopes.some((scope) => configuredScopes.has(scope));
    if (!hasScope) {
      throw new DriveScopeError(this.ctx.space, requiredScopes);
    }
  }

  private async parseDriveError(response: Response): Promise<DriveApiError> {
    let message = `Drive API error: ${response.status}`;
    let reason = "unknown";
    try {
      const body = (await response.json()) as {
        error?: { message?: string; errors?: Array<{ reason?: string }> };
      };
      message = body.error?.message ?? message;
      reason = body.error?.errors?.[0]?.reason ?? reason;
    } catch {
      // keep defaults
    }
    return new DriveApiError(message, response.status, reason);
  }

  private async driveRequest(
    driveOperationEndpoint: string,
    driveOperationSubpath: string,
    init?: RequestInit,
  ): Promise<Response> {
    const response = await this.ctx.oauth.authorizedFetch(
      `${driveOperationEndpoint}${driveOperationSubpath}`,
      init,
    );
    if (!response.ok) {
      throw await this.parseDriveError(response);
    }
    return response;
  }

  private async queryFiles(query: string): Promise<DriveFileEntry[]> {
    const files: DriveFileEntry[] = [];
    let pageToken: string | undefined;

    do {
      const params = new URLSearchParams({
        spaces: this.ctx.space,
        q: query,
        fields: "nextPageToken,files(id,name,createdTime,mimeType)",
        pageSize: "100",
      });
      if (pageToken) params.set("pageToken", pageToken);

      const response = await this.driveRequest(
        METADATA_OPERATIONS_ENDPOINT,
        `/files?${params.toString()}`,
      );
      const result = (await response.json()) as {
        files?: DriveFileEntry[];
        nextPageToken?: string;
      };
      for (const file of result.files ?? []) files.push(file);
      pageToken = result.nextPageToken;
    } while (pageToken);

    return files;
  }

  private findFolderMatches(
    folderId: string,
    folderName: string,
  ): Promise<DriveFileEntry[]> {
    const escapedName = folderName.replace(/'/g, "\\'");
    const query = `name='${escapedName}' and '${folderId}' in parents and mimeType='${FOLDER_MIME_TYPE}' and trashed=false`;
    return this.queryFiles(query);
  }

  private async folderSegmentId(
    parentId: string,
    folderName: string,
    createMissing: boolean,
  ): Promise<string> {
    const matches = await this.findFolderMatches(parentId, folderName);
    if (matches.length > 1) {
      throw new DriveAmbiguousPathError(parentId, folderName);
    }
    if (matches.length === 1) return matches[0]!.id;
    if (!createMissing) {
      throw new DriveApiError(`Folder not found: ${folderName}`, 404, "notFound");
    }

    const response = await this.driveRequest(
      METADATA_OPERATIONS_ENDPOINT,
      "/files?fields=id",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: folderName,
          mimeType: FOLDER_MIME_TYPE,
          parents: [parentId],
        }),
      },
    );
    const created = (await response.json()) as { id: string };
    return created.id;
  }

  private async walkFolderPath(
    startFolderId: string,
    segments: string[],
    createMissing: boolean,
  ): Promise<string> {
    let folderId = startFolderId;
    let currentPath = "";

    for (const segment of segments) {
      folderId = await this.folderSegmentId(folderId, segment, createMissing);
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      this.pathToFolderIdMap.set(currentPath, folderId);
    }

    return folderId;
  }

  private async resolveRootFolder(rootFolderPath: string): Promise<void> {
    const segments = this.normalizePath(rootFolderPath);
    this.pathToFolderIdMap = new Map<string, string>();
    const spaceRootParentId =
      this.ctx.space === "appDataFolder" ? "appDataFolder" : "root";

    this.rootFolderId =
      segments.length === 0
        ? spaceRootParentId
        : await this.walkFolderPath(spaceRootParentId, segments, true);

    this.pathToFolderIdMap.set("", this.rootFolderId);
  }
}

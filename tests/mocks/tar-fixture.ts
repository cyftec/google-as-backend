function writeTarField(header: Uint8Array, start: number, value: string, length: number): void {
  const encoded = new TextEncoder().encode(value);
  header.set(encoded.subarray(0, length), start);
}

function padTarContent(content: Uint8Array): Uint8Array {
  const paddedLength = Math.ceil(content.length / 512) * 512;
  const padded = new Uint8Array(paddedLength);
  padded.set(content);
  return padded;
}

function createTarHeader(entryName: string, size: number): Uint8Array {
  const header = new Uint8Array(512);
  writeTarField(header, 0, entryName, 100);
  writeTarField(header, 124, `${size.toString(8).padStart(11, '0')} `, 12);
  writeTarField(header, 148, '0', 8);
  return header;
}

function concatBlocks(blocks: Uint8Array[]): Uint8Array {
  const total = blocks.reduce((sum, block) => sum + block.length, 0);
  const archive = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    archive.set(block, offset);
    offset += block.length;
  }
  return archive;
}

export function createTarArchive(entries: Record<string, string>): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const [entryName, content] of Object.entries(entries)) {
    const bytes = new TextEncoder().encode(content);
    blocks.push(createTarHeader(entryName, bytes.length));
    blocks.push(padTarContent(bytes));
  }
  blocks.push(new Uint8Array(512));
  return concatBlocks(blocks);
}

export async function createTarGzFixture(
  tarGzPath: string,
  entries: Record<string, string>,
): Promise<string> {
  const archive = createTarArchive(entries);
  await Bun.write(tarGzPath, Bun.gzipSync(new Uint8Array(archive)));
  return tarGzPath;
}

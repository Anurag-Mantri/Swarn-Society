import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileAdapter, loadFileAdapterConfig, type FileAdapterConfig } from "./file-adapter.js";
import type { AdapterExchange } from "./transport.js";

const directories: string[] = [];
const config = (root: string): FileAdapterConfig => ({
  adapterId: "00000000-0000-4000-8000-000000000001",
  manifestId: "00000000-0000-4000-8000-000000000002",
  channelId: "00000000-0000-4000-8000-000000000003",
  root, file: "notes.txt", resourceType: "document",
});

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "swarmroom-file-adapter-"));
  directories.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("manual file adapter", () => {
  it("validates host-only configuration and blocks path traversal", () => {
    expect(loadFileAdapterConfig(undefined)).toBeUndefined();
    expect(loadFileAdapterConfig(JSON.stringify(config(tmpdir())))).toEqual(config(tmpdir()));
    expect(() => loadFileAdapterConfig(JSON.stringify({ ...config(tmpdir()), file: "../outside.txt" }))).toThrow();
  });

  it.skipIf(process.platform !== "linux")("sends metadata and a digest without filenames or file contents", async () => {
    const root = await temporaryRoot();
    const contents = "private local file contents";
    await writeFile(join(root, "notes.txt"), contents);
    const exchange = vi.fn<AdapterExchange>().mockResolvedValue(undefined);
    await createFileAdapter(config(root))(exchange, new AbortController().signal);

    const frames = exchange.mock.calls.map(([frame]) => frame);
    expect(frames.map(({ t }) => t)).toEqual([
      "adapter.register", "adapter.session.start", "adapter.resource", "adapter.snapshot", "adapter.session.stop",
    ]);
    expect(frames[3]).toMatchObject({
      format: "metadata-json", sha256: createHash("sha256").update(contents).digest("hex"), byteLength: Buffer.byteLength(contents),
    });
    expect(JSON.stringify(frames)).not.toContain(contents);
    expect(JSON.stringify(frames)).not.toContain("notes.txt");
    expect(JSON.stringify(frames)).not.toContain(root);
  });

  it.skipIf(process.platform !== "linux")("stops a session on denial and rejects symlinks outside the approved root", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const source = join(outside, "notes.txt");
    await writeFile(source, "outside file");
    await symlink(source, join(root, "notes.txt"));
    const exchange = vi.fn<AdapterExchange>().mockResolvedValue(undefined);
    await expect(createFileAdapter(config(root))(exchange, new AbortController().signal)).rejects.toThrow("outside its approved root");
    expect(exchange.mock.calls.map(([frame]) => frame.t)).toEqual(["adapter.register", "adapter.session.start", "adapter.session.stop"]);

    exchange.mockReset();
    exchange.mockRejectedValueOnce(new Error("Denied"));
    await expect(createFileAdapter(config(root))(exchange, new AbortController().signal)).rejects.toThrow("Denied");
    expect(exchange).toHaveBeenCalledTimes(1);
  });
});

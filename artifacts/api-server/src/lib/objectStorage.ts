import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { Storage, type File } from "@google-cloud/storage";

const SIDECAR_ENDPOINT = "http://127.0.0.1:1106";
const MAX_WORKBOOK_BYTES = 5 * 1024 * 1024;

export const objectStorageClient = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${SIDECAR_ENDPOINT}/credential`,
      format: {
        type: "json",
        subject_token_field_name: "access_token",
      },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
  }
}

export class InvalidWorkbookError extends Error {
  constructor() {
    super("Workbook size is invalid.");
    this.name = "InvalidWorkbookError";
  }
}

export class ObjectStorageService {
  createStockCountWorkbookPath(
    storeroomId: number,
    countId: number,
  ): string {
    return `/objects/count-workbooks/${storeroomId}/${countId}/${randomUUID()}.xlsx`;
  }

  async getUploadUrl(objectPath: string): Promise<string> {
    const { bucketName, objectName } = this.resolvePrivatePath(objectPath);
    return this.signObjectUrl(bucketName, objectName, "PUT");
  }

  async getObjectEntityFile(objectPath: string): Promise<File> {
    const { bucketName, objectName } = this.resolvePrivatePath(objectPath);
    const file = objectStorageClient.bucket(bucketName).file(objectName);
    const [exists] = await file.exists();
    if (!exists) throw new ObjectNotFoundError();
    return file;
  }

  async deleteObject(objectPath: string): Promise<void> {
    const { bucketName, objectName } = this.resolvePrivatePath(objectPath);
    await objectStorageClient
      .bucket(bucketName)
      .file(objectName)
      .delete({ ignoreNotFound: true });
  }

  async downloadObject(file: File): Promise<Response> {
    const [metadata] = await file.getMetadata();
    const webStream = Readable.toWeb(file.createReadStream()) as ReadableStream;
    const headers: Record<string, string> = {
      "Content-Type":
        metadata.contentType ||
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Cache-Control": "private, no-store",
    };
    if (metadata.size) headers["Content-Length"] = String(metadata.size);
    return new Response(webStream, {
      headers,
    });
  }

  async getWorkbookMetadata(file: File): Promise<{ size: number }> {
    const [metadata] = await file.getMetadata();
    const size = Number(metadata.size);
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_WORKBOOK_BYTES) {
      throw new InvalidWorkbookError();
    }
    const contentType = metadata.contentType;
    if (
      contentType &&
      ![
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/octet-stream",
      ].includes(contentType)
    ) {
      throw new InvalidWorkbookError();
    }
    return { size };
  }

  private resolvePrivatePath(objectPath: string): {
    bucketName: string;
    objectName: string;
  } {
    if (
      !objectPath.startsWith("/objects/count-workbooks/") ||
      objectPath.includes("..") ||
      objectPath.includes("\\")
    ) {
      throw new ObjectNotFoundError();
    }
    const privateDir = process.env.PRIVATE_OBJECT_DIR;
    if (!privateDir) throw new Error("PRIVATE_OBJECT_DIR is not configured.");
    const privateRoot = privateDir.endsWith("/") ? privateDir.slice(0, -1) : privateDir;
    const [bucketName, ...rootParts] = privateRoot.replace(/^\/+/, "").split("/");
    const objectName = [
      ...rootParts,
      objectPath.slice("/objects/".length),
    ].join("/");
    if (!bucketName || !objectName) throw new Error("Private object path is invalid.");
    return { bucketName, objectName };
  }

  private async signObjectUrl(
    bucketName: string,
    objectName: string,
    method: "PUT",
  ): Promise<string> {
    const response = await fetch(
      `${SIDECAR_ENDPOINT}/object-storage/signed-object-url`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bucket_name: bucketName,
          object_name: objectName,
          method,
          expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      throw new Error(`Failed to generate signed upload URL (${response.status}).`);
    }
    const result = (await response.json()) as { signed_url?: string };
    if (!result.signed_url) throw new Error("Storage returned no signed upload URL.");
    return result.signed_url;
  }
}

import type { Readable } from 'node:stream';
import { DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { ContainerClient } from '@azure/storage-blob';

export interface AzureBlobProperties {
  contentLength?: number;
  contentType?: string;
  lastModified?: Date;
}

export interface AzureBlobDownload extends AzureBlobProperties {
  data: Readable;
}

export interface AzureBlobItem extends AzureBlobProperties {
  name: string;
}

/**
 * Minimal Azure Blob Storage contract used by {@link AzureBlobDataAccessor}.
 * Keeping this interface independent of the Azure SDK makes the accessor straightforward to test.
 */
export interface AzureBlobStorage {
  download: (name: string) => Promise<AzureBlobDownload>;
  getProperties: (name: string) => Promise<AzureBlobProperties>;
  list: (prefix: string) => AsyncIterableIterator<AzureBlobItem>;
  upload: (name: string, data: Readable, contentType?: string) => Promise<void>;
  delete: (name: string) => Promise<boolean>;
}

export interface AzureBlobStorageClientArgs {
  /** Azure Storage account name. */
  accountName: string;
  /** Existing private blob container used by CSS. */
  containerName: string;
  /** Client ID of a user-assigned managed identity. Omit for system-assigned identity or local credentials. */
  managedIdentityClientId?: string;
  /** Use only Azure managed identity. Disable to use the local-development DefaultAzureCredential chain. */
  useManagedIdentity?: boolean;
}

/**
 * Azure SDK adapter that uses a specific managed identity in production.
 * DefaultAzureCredential can be enabled for Azure CLI or environment credentials during local development.
 */
export class AzureBlobStorageClient implements AzureBlobStorage {
  private readonly client: ContainerClient;

  public constructor(args: AzureBlobStorageClientArgs) {
    let credential: DefaultAzureCredential | ManagedIdentityCredential;
    if (args.useManagedIdentity) {
      credential = args.managedIdentityClientId ?
          new ManagedIdentityCredential(args.managedIdentityClientId) :
          new ManagedIdentityCredential();
    } else {
      credential = args.managedIdentityClientId ?
          new DefaultAzureCredential({ managedIdentityClientId: args.managedIdentityClientId }) :
          new DefaultAzureCredential();
    }
    this.client = new ContainerClient(
      `https://${args.accountName}.blob.core.windows.net/${args.containerName}`,
      credential,
    );
  }

  public async download(name: string): Promise<AzureBlobDownload> {
    const response = await this.client.getBlobClient(name).download();
    if (!response.readableStreamBody) {
      throw new Error(`Azure Blob Storage returned no readable body for ${name}`);
    }
    return {
      data: response.readableStreamBody as Readable,
      contentLength: response.contentLength,
      contentType: response.contentType,
      lastModified: response.lastModified,
    };
  }

  public async getProperties(name: string): Promise<AzureBlobProperties> {
    const response = await this.client.getBlobClient(name).getProperties();
    return {
      contentLength: response.contentLength,
      contentType: response.contentType,
      lastModified: response.lastModified,
    };
  }

  public async* list(prefix: string): AsyncIterableIterator<AzureBlobItem> {
    for await (const item of this.client.listBlobsByHierarchy('/', { prefix })) {
      if (item.kind === 'blob') {
        yield {
          name: item.name,
          contentLength: item.properties.contentLength,
          contentType: item.properties.contentType,
          lastModified: item.properties.lastModified,
        };
      }
    }
  }

  public async upload(name: string, data: Readable, contentType?: string): Promise<void> {
    await this.client.getBlockBlobClient(name).uploadStream(data, undefined, undefined, {
      blobHTTPHeaders: contentType ? { blobContentType: contentType } : undefined,
    });
  }

  public async delete(name: string): Promise<boolean> {
    const response = await this.client.getBlobClient(name).deleteIfExists({ deleteSnapshots: 'include' });
    return response.succeeded;
  }
}

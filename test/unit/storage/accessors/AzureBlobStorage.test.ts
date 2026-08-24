import { DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { ContainerClient } from '@azure/storage-blob';
import { guardedStreamFrom } from '@solid/community-server';
import { AzureBlobStorageClient } from '../../../../src/storage/accessors/AzureBlobStorage';

jest.mock('@azure/identity');
jest.mock('@azure/storage-blob');

describe('An AzureBlobStorageClient', (): void => {
  let blobClient: Record<string, jest.Mock>;
  let blockBlobClient: Record<string, jest.Mock>;
  let containerClient: Record<string, jest.Mock>;

  beforeEach((): void => {
    jest.clearAllMocks();
    blobClient = {
      deleteIfExists: jest.fn(),
      download: jest.fn(),
      getProperties: jest.fn(),
    };
    blockBlobClient = { uploadStream: jest.fn() };
    containerClient = {
      getBlobClient: jest.fn().mockReturnValue(blobClient),
      getBlockBlobClient: jest.fn().mockReturnValue(blockBlobClient),
      listBlobsByHierarchy: jest.fn(),
    };
    jest.mocked(ContainerClient).mockReturnValue(containerClient as any);
  });

  it('uses a system-assigned managed identity by default in Azure.', (): void => {
    expect(new AzureBlobStorageClient({
      accountName: 'storage-account',
      containerName: 'css',
      useManagedIdentity: true,
    })).toBeInstanceOf(AzureBlobStorageClient);

    expect(ManagedIdentityCredential).toHaveBeenCalledWith();
    expect(DefaultAzureCredential).not.toHaveBeenCalled();
    expect(ContainerClient).toHaveBeenCalledWith(
      'https://storage-account.blob.core.windows.net/css',
      expect.any(ManagedIdentityCredential),
    );
  });

  it('can select a user-assigned managed identity.', (): void => {
    expect(new AzureBlobStorageClient({
      accountName: 'storage-account',
      containerName: 'css',
      managedIdentityClientId: 'client-id',
      useManagedIdentity: true,
    })).toBeInstanceOf(AzureBlobStorageClient);

    expect(ManagedIdentityCredential).toHaveBeenCalledWith('client-id');
    expect(DefaultAzureCredential).not.toHaveBeenCalled();
  });

  it('can use the default credential chain for local development.', (): void => {
    expect(new AzureBlobStorageClient({
      accountName: 'storage-account',
      containerName: 'css',
    })).toBeInstanceOf(AzureBlobStorageClient);

    expect(DefaultAzureCredential).toHaveBeenCalledWith();
    expect(ManagedIdentityCredential).not.toHaveBeenCalled();
  });

  it('can select a user-assigned identity in the default credential chain.', (): void => {
    expect(new AzureBlobStorageClient({
      accountName: 'storage-account',
      containerName: 'css',
      managedIdentityClientId: 'client-id',
    })).toBeInstanceOf(AzureBlobStorageClient);

    expect(DefaultAzureCredential).toHaveBeenCalledWith({ managedIdentityClientId: 'client-id' });
  });

  it('downloads blob streams and properties.', async(): Promise<void> => {
    const stream = guardedStreamFrom([ 'data' ]);
    blobClient.download.mockResolvedValue({
      contentLength: 4,
      contentType: 'text/plain',
      lastModified: new Date('2026-08-24T12:00:00.000Z'),
      readableStreamBody: stream,
    });
    blobClient.getProperties.mockResolvedValue({ contentLength: 4, contentType: 'text/plain' });
    const storage = new AzureBlobStorageClient({ accountName: 'storage-account', containerName: 'css' });

    await expect(storage.download('document')).resolves.toEqual({
      contentLength: 4,
      contentType: 'text/plain',
      data: stream,
      lastModified: new Date('2026-08-24T12:00:00.000Z'),
    });
    await expect(storage.getProperties('document')).resolves.toEqual({
      contentLength: 4,
      contentType: 'text/plain',
      lastModified: undefined,
    });
  });

  it('rejects an Azure download without a readable stream.', async(): Promise<void> => {
    blobClient.download.mockResolvedValue({ readableStreamBody: undefined });
    const storage = new AzureBlobStorageClient({ accountName: 'storage-account', containerName: 'css' });
    await expect(storage.download('document')).rejects.toThrow('no readable body');
  });

  it('lists only blob items from the requested hierarchy.', async(): Promise<void> => {
    containerClient.listBlobsByHierarchy.mockReturnValue((async function* (): AsyncIterableIterator<any> {
      yield { kind: 'prefix', name: 'documents/container/' };
      yield {
        kind: 'blob',
        name: 'documents/resource',
        properties: { contentLength: 4, contentType: 'text/plain' },
      };
    })());
    const storage = new AzureBlobStorageClient({ accountName: 'storage-account', containerName: 'css' });
    const items = [];
    for await (const item of storage.list('documents/')) {
      items.push(item);
    }

    expect(containerClient.listBlobsByHierarchy).toHaveBeenCalledWith('/', { prefix: 'documents/' });
    expect(items).toEqual([{
      contentLength: 4,
      contentType: 'text/plain',
      lastModified: undefined,
      name: 'documents/resource',
    }]);
  });

  it('uploads streams with optional content types and deletes blobs with snapshots.', async(): Promise<void> => {
    blobClient.deleteIfExists.mockResolvedValue({ succeeded: true });
    const storage = new AzureBlobStorageClient({ accountName: 'storage-account', containerName: 'css' });
    const typed = guardedStreamFrom([ 'typed' ]);
    const untyped = guardedStreamFrom([ 'untyped' ]);

    await storage.upload('typed', typed, 'text/plain');
    await storage.upload('untyped', untyped);
    expect(blockBlobClient.uploadStream).toHaveBeenNthCalledWith(1, typed, undefined, undefined, {
      blobHTTPHeaders: { blobContentType: 'text/plain' },
    });
    expect(blockBlobClient.uploadStream).toHaveBeenNthCalledWith(2, untyped, undefined, undefined, {
      blobHTTPHeaders: undefined,
    });
    await expect(storage.delete('typed')).resolves.toBe(true);
    expect(blobClient.deleteIfExists).toHaveBeenCalledWith({ deleteSnapshots: 'include' });
  });
});

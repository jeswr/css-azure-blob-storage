import 'jest-rdf';
import type { Readable } from 'node:stream';
import { DataFactory as DF } from 'n3';
import type { Representation } from '@solid/community-server';
import {
  APPLICATION_OCTET_STREAM,
  DC,
  guardedStreamFrom,
  LDP,
  NotFoundHttpError,
  parseContentType,
  POSIX,
  RDF,
  readableToString,
  RepresentationMetadata,
  SOLID_META,
  toLiteral,
  UnsupportedMediaTypeHttpError,
  XSD,
} from '@solid/community-server';
import { AzureBlobDataAccessor } from '../../../../src/storage/accessors/AzureBlobDataAccessor';
import type {
  AzureBlobDownload,
  AzureBlobItem,
  AzureBlobProperties,
  AzureBlobStorage,
} from '../../../../src/storage/accessors/AzureBlobStorage';

interface StoredBlob extends AzureBlobProperties {
  data: Buffer;
}

class MemoryAzureBlobStorage implements AzureBlobStorage {
  public readonly blobs = new Map<string, StoredBlob>();

  public readonly uploads: string[] = [];

  public async download(name: string): Promise<AzureBlobDownload> {
    const blob = this.getBlob(name);
    return { ...blob, data: guardedStreamFrom([ blob.data ]) };
  }

  public async getProperties(name: string): Promise<AzureBlobProperties> {
    return this.getBlob(name);
  }

  public async* list(prefix: string): AsyncIterableIterator<AzureBlobItem> {
    for (const [ name, blob ] of this.blobs) {
      const suffix = name.slice(prefix.length);
      if (name.startsWith(prefix) && suffix.length > 0 && !suffix.includes('/')) {
        yield { name, ...blob };
      }
    }
  }

  public async upload(name: string, data: Readable, contentType?: string): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of data) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    const value = Buffer.concat(chunks);
    this.blobs.set(name, {
      contentLength: value.length,
      contentType,
      data: value,
      lastModified: new Date('2026-08-24T12:00:00.000Z'),
    });
    this.uploads.push(name);
  }

  public async delete(name: string): Promise<boolean> {
    return this.blobs.delete(name);
  }

  private getBlob(name: string): StoredBlob {
    const blob = this.blobs.get(name);
    if (!blob) {
      throw Object.assign(new Error('Blob not found'), { code: 'BlobNotFound', statusCode: 404 });
    }
    return blob;
  }
}

describe('An AzureBlobDataAccessor', (): void => {
  const baseUrl = 'https://example.com/';
  const modified = new Date('2026-08-24T12:00:00.000Z');
  let storage: MemoryAzureBlobStorage;
  let accessor: AzureBlobDataAccessor;

  beforeEach((): void => {
    storage = new MemoryAzureBlobStorage();
    accessor = new AzureBlobDataAccessor({ baseUrl, storage, rootPath: '/css/' });
  });

  it('only accepts binary representations.', async(): Promise<void> => {
    await expect(accessor.canHandle({ binary: true } as Representation)).resolves.toBeUndefined();
    await expect(accessor.canHandle({ binary: false } as Representation))
      .rejects.toThrow(UnsupportedMediaTypeHttpError);
  });

  it('rejects identifiers outside the configured base URL.', async(): Promise<void> => {
    await expect(accessor.getData({ path: 'https://other.example/resource' })).rejects.toThrow(NotFoundHttpError);
  });

  it('normalizes a base URL and supports storing without a root prefix.', async(): Promise<void> => {
    accessor = new AzureBlobDataAccessor({ baseUrl: 'https://example.com', storage });
    const identifier = { path: `${baseUrl}resource` };
    await accessor.writeDocument(
      identifier,
      guardedStreamFrom([ 'data' ]),
      new RepresentationMetadata(identifier),
    );
    expect(storage.blobs.has('documents/resource')).toBe(true);
  });

  it('streams document data to and from Blob Storage.', async(): Promise<void> => {
    const identifier = { path: `${baseUrl}folder/resource` };
    const metadata = new RepresentationMetadata(identifier, 'text/plain');
    await accessor.writeDocument(identifier, guardedStreamFrom([ 'hello ', 'world' ]), metadata);

    expect(storage.uploads).toContain('css/documents/folder/resource');
    expect(storage.blobs.get('css/documents/folder/resource')?.contentType).toBe('text/plain');
    await expect(readableToString(await accessor.getData(identifier))).resolves.toBe('hello world');
  });

  it('preserves content-type parameters in blob headers.', async(): Promise<void> => {
    const identifier = { path: `${baseUrl}resource` };
    const metadata = new RepresentationMetadata(identifier);
    metadata.contentTypeObject = parseContentType('text/plain; charset=utf-8');
    await accessor.writeDocument(identifier, guardedStreamFrom([ 'data' ]), metadata);

    expect(storage.blobs.get('css/documents/resource')?.contentType).toBe('text/plain; charset=utf-8');
    expect((await accessor.getMetadata(identifier)).contentTypeObject?.parameters).toEqual({ charset: 'utf-8' });
    expect(storage.blobs.has('css/metadata/documents/resource')).toBe(false);
  });

  it('stores arbitrary RDF metadata in a companion blob without mutating the input.', async(): Promise<void> => {
    const identifier = { path: `${baseUrl}resource` };
    const predicate = DF.namedNode('https://example.com/tag');
    const metadata = new RepresentationMetadata(identifier, 'text/plain')
      .add(predicate, [ 'one', 'two' ])
      .add(RDF.terms.type, LDP.terms.Resource);

    await accessor.writeDocument(identifier, guardedStreamFrom([ 'data' ]), metadata);

    expect(metadata.getAll(predicate)).toHaveLength(2);
    expect(metadata.getAll(RDF.terms.type)).toHaveLength(1);
    expect(storage.blobs.has('css/metadata/documents/resource')).toBe(true);
    const result = await accessor.getMetadata(identifier);
    expect(result.getAll(predicate)).toEqualRdfTermArray([ DF.literal('one'), DF.literal('two') ]);
  });

  it('generates resource, modification, and size metadata from blob properties.', async(): Promise<void> => {
    const identifier = { path: `${baseUrl}resource` };
    storage.blobs.set('css/documents/resource', {
      contentLength: 4,
      contentType: 'text/turtle',
      data: Buffer.from('data'),
      lastModified: modified,
    });

    const metadata = await accessor.getMetadata(identifier);
    expect(metadata.contentType).toBe('text/turtle');
    expect(metadata.getAll(RDF.terms.type)).toEqualRdfTermArray([ LDP.terms.Resource ]);
    expect(metadata.get(DC.terms.modified)).toEqualRdfTerm(toLiteral(modified.toISOString(), XSD.terms.dateTime));
    expect(metadata.get(POSIX.terms.mtime, SOLID_META.terms.ResponseMetadata))
      .toEqualRdfTerm(toLiteral(modified.getTime() / 1000, XSD.terms.integer));
    expect(metadata.get(POSIX.terms.size, SOLID_META.terms.ResponseMetadata))
      .toEqualRdfTerm(toLiteral(4, XSD.terms.integer));
  });

  it('defaults missing and invalid content types to application/octet-stream.', async(): Promise<void> => {
    const missing = { path: `${baseUrl}missing-type` };
    storage.blobs.set('css/documents/missing-type', { contentLength: 0, data: Buffer.from('') });
    expect((await accessor.getMetadata(missing)).contentType).toBe(APPLICATION_OCTET_STREAM);

    const invalid = { path: `${baseUrl}invalid-type` };
    storage.blobs.set('css/documents/invalid-type', {
      contentLength: 0,
      contentType: 'invalid',
      data: Buffer.from(''),
    });
    expect((await accessor.getMetadata(invalid)).contentType).toBe(APPLICATION_OCTET_STREAM);
  });

  it('uses the latest modification time of the data and metadata blobs.', async(): Promise<void> => {
    const identifier = { path: `${baseUrl}resource` };
    const metadata = new RepresentationMetadata(identifier).add(DF.namedNode('https://example.com/tag'), 'value');
    await accessor.writeDocument(identifier, guardedStreamFrom([ 'data' ]), metadata);
    storage.blobs.get('css/documents/resource')!.lastModified = new Date('2026-08-24T10:00:00.000Z');
    storage.blobs.get('css/metadata/documents/resource')!.lastModified = modified;

    expect((await accessor.getMetadata(identifier)).get(DC.terms.modified))
      .toEqualRdfTerm(toLiteral(modified.toISOString(), XSD.terms.dateTime));
  });

  it('represents containers with marker blobs, including the root container.', async(): Promise<void> => {
    const root = { path: baseUrl };
    await accessor.writeContainer(root, new RepresentationMetadata(root));

    expect(storage.blobs.has('css/containers/.root')).toBe(true);
    const metadata = await accessor.getMetadata(root);
    expect(metadata.getAll(RDF.terms.type)).toEqualRdfTermArray([
      LDP.terms.Container,
      LDP.terms.BasicContainer,
      LDP.terms.Resource,
    ]);
    expect(metadata.get(POSIX.terms.size)).toBeUndefined();
  });

  it('lists only immediate document and container children.', async(): Promise<void> => {
    const root = { path: baseUrl };
    await accessor.writeContainer(root, new RepresentationMetadata(root));
    await accessor.writeDocument(
      { path: `${baseUrl}resource` },
      guardedStreamFrom([ 'data' ]),
      new RepresentationMetadata('text/plain'),
    );
    await accessor.writeContainer(
      { path: `${baseUrl}container/` },
      new RepresentationMetadata({ path: `${baseUrl}container/` }),
    );
    await accessor.writeDocument(
      { path: `${baseUrl}container/nested` },
      guardedStreamFrom([ 'nested' ]),
      new RepresentationMetadata('text/plain'),
    );

    const children = [];
    for await (const child of accessor.getChildren(root)) {
      children.push(child);
    }
    expect(children.map((child): string => child.identifier.value).sort()).toEqual([
      `${baseUrl}container/`,
      `${baseUrl}resource`,
    ]);
  });

  it('uses default child metadata when Azure properties are absent.', async(): Promise<void> => {
    const root = { path: baseUrl };
    storage.blobs.set('css/containers/.root', { data: Buffer.from('') });
    storage.blobs.set('css/documents/resource', { data: Buffer.from('') });
    const children = [];
    for await (const child of accessor.getChildren(root)) {
      children.push(child);
    }
    expect(children).toHaveLength(1);
    expect(children[0].contentType).toBe(APPLICATION_OCTET_STREAM);
    expect(children[0].get(DC.terms.modified)).toBeUndefined();
  });

  it('throws a 404 for missing data, metadata, and containers.', async(): Promise<void> => {
    const missing = { path: `${baseUrl}missing` };
    await expect(accessor.getData(missing)).rejects.toThrow(NotFoundHttpError);
    await expect(accessor.getMetadata(missing)).rejects.toThrow(NotFoundHttpError);
    await expect((async(): Promise<void> => {
      for await (const child of accessor.getChildren({ path: `${baseUrl}missing/` })) {
        void child;
      }
    })()).rejects.toThrow(NotFoundHttpError);
  });

  it('deletes both resource and companion metadata blobs.', async(): Promise<void> => {
    const identifier = { path: `${baseUrl}resource` };
    const metadata = new RepresentationMetadata(identifier, 'text/plain')
      .add(DF.namedNode('https://example.com/tag'), 'value');
    await accessor.writeDocument(identifier, guardedStreamFrom([ 'data' ]), metadata);

    await expect(accessor.deleteResource(identifier)).resolves.toBeUndefined();
    expect(storage.blobs.has('css/documents/resource')).toBe(false);
    expect(storage.blobs.has('css/metadata/documents/resource')).toBe(false);
    await expect(accessor.deleteResource(identifier)).rejects.toThrow(NotFoundHttpError);
  });

  it('updates companion metadata independently.', async(): Promise<void> => {
    const identifier = { path: `${baseUrl}resource` };
    storage.blobs.set('css/documents/resource', { data: Buffer.from('data') });
    await accessor.writeMetadata(
      identifier,
      new RepresentationMetadata(identifier).add(DF.namedNode('https://example.com/tag'), 'value'),
    );
    expect(storage.blobs.has('css/metadata/documents/resource')).toBe(true);
  });

  it('removes a stale companion blob when there is no custom metadata.', async(): Promise<void> => {
    const identifier = { path: `${baseUrl}resource` };
    storage.blobs.set('css/metadata/documents/resource', { data: Buffer.from('stale') });
    await accessor.writeDocument(
      identifier,
      guardedStreamFrom([ 'data' ]),
      new RepresentationMetadata(identifier, 'text/plain'),
    );

    expect(storage.blobs.has('css/metadata/documents/resource')).toBe(false);
  });

  it('propagates unexpected data, property, listing, and metadata errors.', async(): Promise<void> => {
    const identifier = { path: `${baseUrl}resource` };
    const unexpected = new Error('unexpected');

    jest.spyOn(storage, 'download').mockRejectedValueOnce(unexpected);
    await expect(accessor.getData(identifier)).rejects.toBe(unexpected);

    jest.spyOn(storage, 'getProperties').mockRejectedValueOnce(unexpected);
    await expect(accessor.getMetadata(identifier)).rejects.toBe(unexpected);

    jest.spyOn(storage, 'getProperties').mockRejectedValueOnce(unexpected);
    await expect((async(): Promise<void> => {
      for await (const child of accessor.getChildren({ path: baseUrl })) {
        void child;
      }
    })()).rejects.toBe(unexpected);

    storage.blobs.set('css/documents/resource', { data: Buffer.from('data') });
    storage.blobs.set('css/metadata/documents/resource', { data: Buffer.from('not n-quads') });
    await expect(accessor.getMetadata(identifier)).rejects.toBeInstanceOf(Error);
  });

  it('recognizes all Azure not-found error forms without hiding other values.', async(): Promise<void> => {
    const identifier = { path: `${baseUrl}resource` };
    jest.spyOn(storage, 'download')
      .mockRejectedValueOnce({ code: 'BlobNotFound' })
      .mockRejectedValueOnce({ code: 'ContainerNotFound' })
      .mockRejectedValueOnce('unexpected')
      .mockRejectedValueOnce({ code: 'Other' });

    await expect(accessor.getData(identifier)).rejects.toThrow(NotFoundHttpError);
    await expect(accessor.getData(identifier)).rejects.toThrow(NotFoundHttpError);
    await expect(accessor.getData(identifier)).rejects.toBe('unexpected');
    await expect(accessor.getData(identifier)).rejects.toEqual({ code: 'Other' });
  });
});

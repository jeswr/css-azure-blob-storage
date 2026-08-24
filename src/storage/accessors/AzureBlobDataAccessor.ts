import type { Readable } from 'node:stream';
import { getLoggerFor } from 'global-logger-factory';
import type { DataAccessor, Guarded, Representation, ResourceIdentifier } from '@solid/community-server';
import {
  addResourceMetadata,
  APPLICATION_OCTET_STREAM,
  DC,
  guardedStreamFrom,
  guardStream,
  IANA,
  isContainerIdentifier,
  LDP,
  NotFoundHttpError,
  parseContentType,
  parseQuads,
  POSIX,
  RDF,
  RepresentationMetadata,
  serializeQuads,
  SOLID_META,
  toLiteral,
  toNamedTerm,
  UnsupportedMediaTypeHttpError,
  updateModifiedDate,
  XSD,
} from '@solid/community-server';
import type { AzureBlobItem, AzureBlobProperties, AzureBlobStorage } from './AzureBlobStorage';

const METADATA_CONTENT_TYPE = 'application/n-quads';
const ROOT_CONTAINER_BLOB = '.root';

export interface AzureBlobDataAccessorArgs {
  /** Public base URL of the CSS instance. */
  baseUrl: string;
  /** Azure Blob Storage client used for persistence. */
  storage: AzureBlobStorage;
  /** Optional prefix used to isolate this CSS instance inside the container. */
  rootPath?: string;
}

interface BlobNames {
  data: string;
  metadata: string;
}

interface StoredMetadata {
  metadata: RepresentationMetadata;
  lastModified?: Date;
}

/**
 * Stores binary representations in Azure Blob Storage.
 * Resource metadata is serialized to companion N-Quads blobs so RDF values are not constrained by Azure metadata.
 */
export class AzureBlobDataAccessor implements DataAccessor {
  protected readonly logger = getLoggerFor(this);

  private readonly baseUrl: string;
  private readonly rootPrefix: string;
  private readonly storage: AzureBlobStorage;

  public constructor(args: AzureBlobDataAccessorArgs) {
    this.baseUrl = args.baseUrl.endsWith('/') ? args.baseUrl : `${args.baseUrl}/`;
    const rootPath = args.rootPath?.replaceAll(/^\/+|\/+$/gu, '');
    this.rootPrefix = rootPath ? `${rootPath}/` : '';
    this.storage = args.storage;
  }

  public async canHandle(representation: Representation): Promise<void> {
    if (!representation.binary) {
      throw new UnsupportedMediaTypeHttpError('Only binary data is supported.');
    }
  }

  public async getData(identifier: ResourceIdentifier): Promise<Guarded<Readable>> {
    const names = this.getBlobNames(identifier);
    try {
      const response = await this.storage.download(names.data);
      return guardStream(response.data);
    } catch (error: unknown) {
      this.handleNotFound(error);
      throw error;
    }
  }

  public async getMetadata(identifier: ResourceIdentifier): Promise<RepresentationMetadata> {
    const names = this.getBlobNames(identifier);
    let properties: AzureBlobProperties;
    try {
      properties = await this.storage.getProperties(names.data);
    } catch (error: unknown) {
      this.handleNotFound(error);
      throw error;
    }

    const stored = await this.getStoredMetadata(identifier, names.metadata);
    const metadata = stored.metadata;
    const isContainer = isContainerIdentifier(identifier);
    addResourceMetadata(metadata, isContainer);
    if (!isContainer) {
      this.addContentType(metadata, properties.contentType ?? APPLICATION_OCTET_STREAM);
    }
    this.addStorageMetadata(metadata, properties, stored.lastModified, isContainer);
    return metadata;
  }

  public async* getChildren(identifier: ResourceIdentifier): AsyncIterableIterator<RepresentationMetadata> {
    const names = this.getBlobNames(identifier);
    try {
      await this.storage.getProperties(names.data);
    } catch (error: unknown) {
      this.handleNotFound(error);
      throw error;
    }

    const relativePath = this.getRelativePath(identifier);
    const documentPrefix = `${this.rootPrefix}documents/${relativePath}`;
    const containerPrefix = `${this.rootPrefix}containers/${relativePath}`;

    for await (const item of this.storage.list(documentPrefix)) {
      yield this.createChildMetadata(item, documentPrefix, identifier, false);
    }
    for await (const item of this.storage.list(containerPrefix)) {
      if (item.name !== `${this.rootPrefix}containers/${ROOT_CONTAINER_BLOB}`) {
        yield this.createChildMetadata(item, containerPrefix, identifier, true);
      }
    }
  }

  public async writeDocument(
    identifier: ResourceIdentifier,
    data: Guarded<Readable>,
    metadata: RepresentationMetadata,
  ): Promise<void> {
    const names = this.getBlobNames(identifier);
    const contentType = metadata.contentTypeObject?.toHeaderValueString() ?? APPLICATION_OCTET_STREAM;
    await this.storage.upload(names.data, data, contentType);
    await this.writeStoredMetadata(names.metadata, metadata);
  }

  public async writeContainer(identifier: ResourceIdentifier, metadata: RepresentationMetadata): Promise<void> {
    const names = this.getBlobNames(identifier);
    await this.storage.upload(names.data, guardedStreamFrom([]));
    await this.writeStoredMetadata(names.metadata, metadata);
  }

  public async writeMetadata(identifier: ResourceIdentifier, metadata: RepresentationMetadata): Promise<void> {
    const names = this.getBlobNames(identifier);
    await this.writeStoredMetadata(names.metadata, metadata);
  }

  public async deleteResource(identifier: ResourceIdentifier): Promise<void> {
    const names = this.getBlobNames(identifier);
    const deleted = await this.storage.delete(names.data);
    if (!deleted) {
      throw new NotFoundHttpError();
    }
    await this.storage.delete(names.metadata);
  }

  private getRelativePath(identifier: ResourceIdentifier): string {
    if (!identifier.path.startsWith(this.baseUrl)) {
      throw new NotFoundHttpError();
    }
    return identifier.path.slice(this.baseUrl.length);
  }

  private getBlobNames(identifier: ResourceIdentifier): BlobNames {
    const relativePath = this.getRelativePath(identifier);
    const isContainer = isContainerIdentifier(identifier);
    const type = isContainer ? 'containers' : 'documents';
    const resourceName = isContainer ? relativePath.replace(/\/$/u, '') || ROOT_CONTAINER_BLOB : relativePath;
    return {
      data: `${this.rootPrefix}${type}/${resourceName}`,
      metadata: `${this.rootPrefix}metadata/${type}/${resourceName}`,
    };
  }

  private async getStoredMetadata(identifier: ResourceIdentifier, name: string): Promise<StoredMetadata> {
    try {
      const response = await this.storage.download(name);
      const quads = await parseQuads(guardStream(response.data), {
        format: METADATA_CONTENT_TYPE,
        baseIRI: identifier.path,
      });
      return {
        metadata: new RepresentationMetadata(identifier).addQuads(quads),
        lastModified: response.lastModified,
      };
    } catch (error: unknown) {
      if (this.isNotFound(error)) {
        return { metadata: new RepresentationMetadata(identifier) };
      }
      throw error;
    }
  }

  private async writeStoredMetadata(name: string, metadata: RepresentationMetadata): Promise<void> {
    const stored = new RepresentationMetadata(metadata);
    stored.remove(RDF.terms.type, LDP.terms.Resource);
    stored.remove(RDF.terms.type, LDP.terms.Container);
    stored.remove(RDF.terms.type, LDP.terms.BasicContainer);
    stored.removeAll(DC.terms.modified);
    stored.removeAll(POSIX.terms.mtime);
    stored.removeAll(POSIX.terms.size);
    stored.contentTypeObject = undefined;

    const quads = stored.quads();
    if (quads.length === 0) {
      await this.storage.delete(name);
    } else {
      await this.storage.upload(name, serializeQuads(quads, METADATA_CONTENT_TYPE), METADATA_CONTENT_TYPE);
    }
  }

  private createChildMetadata(
    item: AzureBlobItem,
    prefix: string,
    parent: ResourceIdentifier,
    isContainer: boolean,
  ): RepresentationMetadata {
    const name = item.name.slice(prefix.length);
    const identifier = { path: `${parent.path}${name}${isContainer ? '/' : ''}` };
    const metadata = new RepresentationMetadata(identifier);
    addResourceMetadata(metadata, isContainer);
    if (!isContainer) {
      this.addContentType(metadata, item.contentType ?? APPLICATION_OCTET_STREAM, true);
    }
    this.addStorageMetadata(metadata, item, undefined, isContainer);
    return metadata;
  }

  private addContentType(metadata: RepresentationMetadata, contentType: string, addIanaType = false): void {
    try {
      const parsed = parseContentType(contentType);
      metadata.contentTypeObject = parsed;
      if (addIanaType) {
        metadata.add(RDF.terms.type, toNamedTerm(`${IANA.namespace}${parsed.value}#Resource`));
      }
    } catch {
      this.logger.warn(`Detected an invalid content-type "${contentType}" for ${metadata.identifier.value}`);
      metadata.contentType = APPLICATION_OCTET_STREAM;
    }
  }

  private addStorageMetadata(
    metadata: RepresentationMetadata,
    properties: AzureBlobProperties,
    metadataModified: Date | undefined,
    isContainer: boolean,
  ): void {
    let lastModified = properties.lastModified;
    if (metadataModified && (!lastModified || metadataModified > lastModified)) {
      lastModified = metadataModified;
    }
    if (lastModified) {
      updateModifiedDate(metadata, lastModified);
      metadata.add(
        POSIX.terms.mtime,
        toLiteral(Math.floor(lastModified.getTime() / 1000), XSD.terms.integer),
        SOLID_META.terms.ResponseMetadata,
      );
    }
    if (!isContainer && typeof properties.contentLength === 'number') {
      metadata.add(
        POSIX.terms.size,
        toLiteral(properties.contentLength, XSD.terms.integer),
        SOLID_META.terms.ResponseMetadata,
      );
    }
  }

  private handleNotFound(error: unknown): void {
    if (this.isNotFound(error)) {
      throw new NotFoundHttpError('', { cause: error });
    }
  }

  private isNotFound(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }
    const response = error as { code?: unknown; statusCode?: unknown };
    return response.statusCode === 404 || response.code === 'BlobNotFound' || response.code === 'ContainerNotFound';
  }
}

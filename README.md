# @jeswr/css-azure-blob-storage

An Azure Blob Storage `DataAccessor` for the
[Community Solid Server](https://github.com/CommunitySolidServer/CommunitySolidServer) (CSS).

Document bodies are streamed directly to block blobs. Containers use zero-byte marker blobs,
and RDF metadata is stored in companion N-Quads blobs so multi-valued metadata, blank nodes,
and named graphs are preserved.

## Install

```shell
npm install @solid/community-server @jeswr/css-azure-blob-storage
```

## Configure

Import the package configuration from your CSS configuration:

```json
{
  "@context": "https://linkedsoftwaredependencies.org/bundles/npm/@solid/community-server/^8.0.0/components/context.jsonld",
  "import": [
    "azb:config/default.json"
  ]
}
```

The configuration adds these CSS command-line options:

| Option | Required | Purpose |
| --- | --- | --- |
| `--azureStorageAccountName` | yes | Azure Storage account name. |
| `--azureStorageContainerName` | yes | Existing private Blob container. |
| `--azureStorageRootPath` | no | Blob prefix; defaults to `css`. |
| `--azureManagedIdentityClientId` | no | Client ID for a user-assigned managed identity. |
| `--azureUseManagedIdentity` | no | Use managed identity only; defaults to `true`. |

Production deployments use `ManagedIdentityCredential`. For local development, pass
`--no-azureUseManagedIdentity` to opt into `DefaultAzureCredential`, for example after an
Azure CLI login.

The container is deliberately not created by this package. Provision it separately and grant
the CSS managed identity `Storage Blob Data Contributor`, scoped to that container where
possible.

## Concurrency

Use the same `ReadWriteLocker` discipline as other CSS backends. A single-replica deployment can
use CSS's memory locker; multiple replicas require a distributed locker so writes cannot race.

## Development

```shell
npm install
npm run verify
```

## Licence

MIT © Jesse Wright

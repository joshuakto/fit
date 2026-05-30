# FIT Architecture

High-level system design for the FIT (File gIT) Obsidian plugin.

## System Overview

FIT enables bidirectional sync between Obsidian vaults and remote git repositories (currently GitHub) with conflict resolution and cross-platform support.

```mermaid
graph TB
    User[👤 User] --> Obsidian[Obsidian UI]
    Obsidian --> FitPlugin[FIT Plugin]

    FitPlugin --> Sync[Sync Engine]
    FitPlugin --> Settings[Settings Manager]
    FitPlugin --> AutoSync[Auto Sync Timer]

    Sync --> Remote[☁️ Remote Vault]
    Sync --> Vault[💾 Local Vault]

    Vault --> ConflictDir[📁 _fit/ Directory]
```

## Core Components

### FitPlugin (src/fitPlugin.ts)
**Purpose**: Plugin orchestrator and lifecycle manager (interfaces with 👤 user)
- Manages plugin loading, settings persistence, auto-sync scheduling
- Coordinates between sync engine and Obsidian UI
- Handles error recovery and user notifications

### Vault Abstractions (IVault)
**Purpose**: Abstract file operations (read/write) for different storage backends

A "vault" represents a complete collection of synced files, whether stored locally (Obsidian vault) or remotely (GitHub repository).

- **IVault Interface**: Common interface for vault operations
  - **Read operations**: `readFromSource()`, `readFileContent(path)`
  - **Write operations**: `applyChanges(filesToWrite, filesToDelete)` - batch operations
  - **Metadata**: `shouldTrackState(path)` - filter paths during sync

- **💾 LocalVault**: Obsidian vault implementation
  - Computes SHA-1 hashes from vault files
  - Owns local state
  - Batch file operations via `applyChanges()`

- **☁️ RemoteGitHubVault**: GitHub repository implementation
  - Fetches remote tree state via GitHub API
  - Owns remote state
  - Creates commits via `applyChanges()` (creates blobs, builds trees, creates commits, updates refs)
  - Handles empty repository case

### SHA Algorithms and Change Detection

Both local and remote caches use the canonical Git blob SHA format: `SHA1("blob " + byteLength + "\0" + rawBytes)`.

- **Local SHA** (`LocalVault.fileSha1`): canonical git blob SHA
  - Used for detecting local changes between syncs
  - Stored in `localShas` cache (part of LocalStores in data.json)
  - Matches GitHub's blob SHA — enables SHA parity optimization (skip download when local SHA equals remote SHA)

- **Remote SHA** (from GitHub API): same git blob SHA format
  - Used for detecting remote changes between syncs
  - Stored in `lastFetchedRemoteShas` cache (part of LocalStores in data.json)
  - Returned directly by the GitHub tree API

**Important:**
- ✅ Local and remote SHAs can be directly compared when encryption is off
- ❌ **NEVER copy remote SHA into `localShas` as a baseline** — baseline must be computed from the file bytes actually written to disk, not from the remote tree entry (which may differ under encryption)
- ✅ When recording baseline for remote content, compute via `LocalVault.fileSha1()` from the bytes written

**Legacy migration (`localSha` singular):**
- Pre-v1.6 used `SHA1(normalizedPath + content)` stored in `localSha` (singular)
- On first sync after upgrade, `getLocalChanges()` batch-migrates all legacy files: re-reads each to verify the legacy SHA still matches, then promotes the canonical SHA to `localShas`
- `localSha` is omitted from storage once fully migrated

**Code references:**
- Local SHA: [`src/localVault.ts` `fileSha1()`](../src/localVault.ts)
- Canonical SHA computation: [`src/util/hashing.ts` `computeGitBlobSha()`](../src/util/hashing.ts)
- Baseline recording: [`src/fitSync.ts`](../src/fitSync.ts)

### Sync Engine (fitSync.ts, fit.ts)
**Purpose**: Core synchronization logic
- **Fit**: Coordinator between vaults with clean abstractions
  - Owns 💾 LocalVault and ☁️ RemoteVault instances (currently RemoteGitHubVault)
  - Provides `getLocalChanges()` / `getRemoteChanges()` abstractions
  - Implements sync policy via `shouldSyncPath()` (ignores paths like 📁 `_fit/` and `.obsidian/`)
  - Detects clashes between local and remote changes via `getClashedChanges()`

- **FitSync**: High-level sync workflow and 🔀 conflict resolution
  - Orchestrates unified bidirectional sync with 🔀 conflict handling
  - All clash detection happens inline at the start of sync
  - Phases: detect clashes → batch stat filesystem → resolve conflicts → push → pull → persist
  - Handles both sync and push-only operations

**Remote Backend Integration**:
- Current implementation: GitHub backend with two components:
  - `GitHubConnection`: PAT-based operations (authentication, repo/branch discovery) for settings UI
  - `RemoteGitHubVault`: Repository-specific sync operations using `@octokit/core` with automatic retry handling
- Architecture supports adding GitLab/Gitea backends via IVault interface (would require corresponding connection classes)

### Support Systems
- **FitLogger**: Cross-platform diagnostic logging (enabled by default, writes to `.obsidian/plugins/fit/debug.log`)
- **Settings UI**: GitHub authentication and configuration management
- **Notifications**: User feedback during sync operations

## Data Flow

### Sync Process

```mermaid
sequenceDiagram
    participant User as 👤 User
    participant Plugin as FitPlugin
    participant Sync as Sync Engine
    participant Local as 💾 Local Vault
    participant Remote as ☁️ Remote Vault

    User->>Plugin: Trigger Sync
    Plugin->>Sync: Initiate sync workflow

    par Read States (from Local/Remote in parallel)
        Sync->>Local: Scan local files
        Sync->>Remote: Fetch remote state
    end

    Sync->>Sync: Detect conflicts

    alt No Conflicts
        Sync->>Local: Apply remote changes
        Sync->>Remote: Push local changes
    else Conflicts Found
        Sync->>Local: Save conflicts to 📁 _fit/
    end

    Sync-->>Plugin: Sync result
    Plugin->>User: Show notification
```

### Change Detection Strategy

**SHA-based Comparison**: Files are compared using SHA hashes rather than timestamps
- **Local Cache**: Tracks SHA of each file from last sync
- **Remote Cache**: Tracks SHA of each remote file from last fetch
- **Incremental Sync**: Only processes files that have changed since last sync

**Benefits**:
- Network efficient (only changed files transferred)
- Handles clock skew between devices
- Reliable conflict detection

📘 **For detailed sync logic, decision trees, conflict resolution, and debugging guide, see [Sync Logic Deep Dive](./sync-logic.md)**

## Storage Architecture

### 📦 Plugin Data
```
.obsidian/plugins/fit/data.json (plain text):
├── settings
│   ├── 🔒 pat (GitHub Personal Access Token)
│   ├── owner, repo, branch
│   ├── deviceName, avatarUrl
│   ├── autoSync preferences
│   └── notification settings
└── localStore (sync state cache)
    ├── localShas (file path -> canonical git blob SHA)
    ├── localSha? (legacy field, present only during migration from pre-v1.6)
    ├── lastFetchedCommitSha
    └── lastFetchedRemoteShas (remote file path -> git blob SHA)

.obsidian/plugins/fit/debug.log:
└── Debug logs (when enabled in settings)
```

### 💾 Vault Structure
```
Obsidian Vault:
├── [user files and folders]
└── 📁 _fit/                 # Conflict resolution directory
    ├── conflicted-file.md   # Remote version of conflicted files
    └── subfolder/
        └── another-conflict.md
```

**Note**: Conflicted files are saved directly in 📁 `_fit/` with the same path structure as the original, containing the remote version. The local version remains in the original location.

## 🔒 Security Model

### Data Protection
- **Credentials**: GitHub PAT stored in 📦 plugin data (currently in plain text)
- **API Security**: All remote API calls use HTTPS with proper authentication
- **Local Storage**: No sensitive data in logs or temporary files

### 🔀 Conflict Handling
- **Non-destructive**: Original files never overwritten during conflicts
- **User Control**: All conflict resolution is manual and user-directed
- **Audit Trail**: Conflicted files preserved in 📁 `_fit/` with timestamps

## Performance Characteristics

### Optimization Strategies
- **Incremental Sync**: SHA-based change detection minimizes data transfer
- **Caching**: Local and remote SHA caches avoid redundant API calls

### Scalability Considerations
- **Large Repositories**: Handles 1000+ files through paginated API calls
- **Large Files**: Supports files up to GitHub's 100MB limit
- **Rate Limiting**: Handled automatically by GitHub API client

## Extension Points

### Adding Sync Backends
Implement the `IVault` interface to support additional remote backends:

```typescript
interface IVault {
    // Read operations
    readFromSource(): Promise<VaultReadResult>;
    readFileContent(path: string): Promise<FileContent>;

    // Write operations
    applyChanges(
        filesToWrite: Array<{path: string, content: FileContent}>,
        filesToDelete: Array<string>
    ): Promise<FileOpRecord[]>;

    // Metadata
    shouldTrackState(path: string): boolean;
}
```

**Example**: Create `RemoteGitLabVault` by:
1. Implement `IVault` interface
2. Use GitLab API to fetch repository tree in `readFromSource()`
3. Compute SHA hashes from GitLab blobs
4. Handle GitLab-specific path filtering in `shouldTrackState()`
5. Implement commit operations in `applyChanges()`

**Current implementations**:
- `LocalVault`: Obsidian vault
- `RemoteGitHubVault`: GitHub repositories

### Custom Conflict Resolution
Extend `FitSync` class to implement custom conflict resolution strategies:
- Auto-merge for specific file types
- Integration with external diff tools
- Custom conflict markers or formats

### Enhanced Notifications
Extend notification system for:
- Integration with other Obsidian plugins
- Desktop notifications outside Obsidian
- Detailed sync reports and statistics

## Design Principles

### Reliability First
- All operations are transactional where possible
- User data is never lost during sync conflicts
- Graceful degradation when network/API issues occur
- Error scenarios should clearly communicate problems to users so they can resolve problems

### 👤 User Agency
- Users maintain full control over conflict resolution
- Clear feedback about what changes will occur
- Easy rollback through git history

### Cross-Platform Consistency
- Identical behavior on desktop and mobile Obsidian
- Platform-agnostic file handling and sync logic
- Consistent UI patterns across environments

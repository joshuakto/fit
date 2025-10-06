# FIT Architecture

High-level system design for the FIT (File gIT) Obsidian plugin.

## System Overview

FIT enables bidirectional sync between Obsidian vaults and GitHub repositories with conflict resolution and cross-platform support.

```mermaid
graph TB
    User[User] --> Obsidian[Obsidian UI]
    Obsidian --> FitPlugin[FIT Plugin]

    FitPlugin --> Sync[Sync Engine]
    FitPlugin --> Settings[Settings Manager]
    FitPlugin --> AutoSync[Auto Sync Timer]

    Sync --> GitHub[GitHub API]
    Sync --> Vault[Local Vault]

    Vault --> ConflictDir[_fit/ Directory]

    classDef core fill:#e1f5fe
    classDef external fill:#f3e5f5
    classDef storage fill:#e8f5e8

    class FitPlugin,Sync core
    class Obsidian,GitHub external
    class Vault,ConflictDir storage
```

## Core Components

### FitPlugin (main.ts)
**Purpose**: Plugin orchestrator and lifecycle manager
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

- **LocalVault**: Obsidian vault implementation
  - Computes SHA-1 hashes from vault files
  - Owns local state
  - Batch file operations via `applyChanges()`

- **RemoteGitHubVault**: GitHub repository implementation
  - Fetches remote tree state via GitHub API
  - Owns remote state
  - Creates commits via `applyChanges()` (creates blobs, builds trees, creates commits, updates refs)
  - Handles empty repository case

### Sync Engine (fit.ts, fitSync.ts, fitPull.ts, fitPush.ts)
**Purpose**: Core synchronization logic
- **Fit**: Coordinator between vaults with clean abstractions
  - Owns LocalVault and RemoteGitHubVault instances
  - Provides `getLocalChanges()` / `getRemoteChanges()` abstractions
  - Implements sync policy via `shouldSyncPath()` (ignores paths like `_fit/`)

- **FitSync**: High-level sync workflow and conflict resolution
  - Uses `Fit.getLocalChanges()` / `getRemoteChanges()` for change detection
  - Orchestrates bidirectional sync with conflict handling

- **FitPull/FitPush**: Pull-only / push-only operations
  - Uses same abstractions for consistency

**GitHub API Integration**:
- RemoteGitHubVault encapsulates all GitHub API calls
- Uses `@octokit/core` with automatic retry handling

### Support Systems
- **Settings UI**: GitHub authentication and configuration management
- **Notifications**: User feedback during sync operations

## Data Flow

### Sync Process

```mermaid
sequenceDiagram
    participant User
    participant Plugin as FitPlugin
    participant Sync as Sync Engine
    participant GitHub as GitHub API
    participant Vault as Local Vault

    User->>Plugin: Trigger Sync
    Plugin->>Sync: Initiate sync workflow

    Sync->>Vault: Scan local files
    Sync->>GitHub: Fetch remote changes

    Sync->>Sync: Detect conflicts

    alt No Conflicts
        Sync->>Vault: Apply remote changes
        Sync->>GitHub: Push local changes
    else Conflicts Found
        Sync->>Vault: Save conflicts to _fit/
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

### Plugin Data
```
.obsidian/plugins/fit/data.json (plain text):
├── settings
│   ├── pat (GitHub Personal Access Token)
│   ├── owner, repo, branch
│   ├── deviceName, avatarUrl
│   ├── autoSync preferences
│   └── notification settings
└── localStore (sync state cache)
    ├── localSha (file path -> SHA map)
    ├── lastFetchedCommitSha
    └── lastFetchedRemoteSha (remote file path -> SHA map)
```

### Vault Structure
```
Obsidian Vault:
├── [user files and folders]
└── _fit/                    # Conflict resolution directory
    ├── conflicted-file.md   # Remote version of conflicted files
    └── subfolder/
        └── another-conflict.md
```

**Note**: Conflicted files are saved directly in `_fit/` with the same path structure as the original, containing the remote version. The local version remains in the original location.

## Security Model

### Data Protection
- **Credentials**: GitHub PAT stored in plugin data (currently in plain text)
- **API Security**: All GitHub API calls use HTTPS with proper authentication
- **Local Storage**: No sensitive data in logs or temporary files

### Conflict Handling
- **Non-destructive**: Original files never overwritten during conflicts
- **User Control**: All conflict resolution is manual and user-directed
- **Audit Trail**: Conflicted files preserved with timestamps

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
    readFromSource(): Promise<FileState>;
    readFileContent(path: string): Promise<string>;

    // Write operations
    applyChanges(filesToWrite: FileToWrite[], filesToDelete: string[]): Promise<FileOpRecord[]>;

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

### User Agency
- Users maintain full control over conflict resolution
- Clear feedback about what changes will occur
- Easy rollback through git history

### Cross-Platform Consistency
- Identical behavior on desktop and mobile Obsidian
- Platform-agnostic file handling and sync logic
- Consistent UI patterns across environments

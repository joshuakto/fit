import { Base64Content, FileContent } from "./util/contentEncoding";
import { BlobSha, CommitSha } from "./util/hashing";

export type LocalFileStatus = "deleted" | "created" | "changed" | "untracked";
export type RemoteChangeType = "ADDED" | "MODIFIED" | "REMOVED";

export type LocalChange = {
	path: string,
	status: LocalFileStatus,
	extension? : string
};

export type LocalUpdate = {
	localChanges: LocalChange[],
	parentCommitSha: CommitSha
};

export type RemoteChange = {
	path: string,
	status: RemoteChangeType,
	currentSha?: BlobSha
};

export type RemoteUpdate = {
	remoteChanges: RemoteChange[],
	remoteTreeSha: Record<string, BlobSha>,
	latestRemoteCommitSha: CommitSha
};

export type ClashStatus = {
	path: string
	localStatus: LocalFileStatus
	remoteStatus: RemoteChangeType
};

export type ConflictReport = {
	path: string
	resolutionStrategy: "utf-8"
	localContent: Base64Content
	remoteContent: Base64Content
} | {
	resolutionStrategy: "binary",
	path: string,
	remoteContent: Base64Content
};

export type ConflictResolutionResult = {
	path: string
	noDiff: boolean
	conflictFile?: { path: string, content: FileContent }  // File to write to _fit/ (if noDiff=false)
};

export type FileOpRecord = {
	path: string
	status: LocalFileStatus
};

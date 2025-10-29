import { Base64Content } from "./contentEncoding";

export type LocalFileStatus = "deleted" | "created" | "changed" | "untracked";
export type RemoteChangeType = "ADDED" | "MODIFIED" | "REMOVED";

export type LocalChange = {
	path: string,
	status: LocalFileStatus,
	extension? : string
};

export type LocalUpdate = {
	localChanges: LocalChange[],
	// localTreeSha: Record<string, string>,
	parentCommitSha: string
};

export type RemoteChange = {
	path: string,
	status: RemoteChangeType,
	currentSha?: string
};

export type RemoteUpdate = {
	remoteChanges: RemoteChange[],
	remoteTreeSha: Record<string, string>,
	latestRemoteCommitSha: string,
	clashedFiles: Array<ClashStatus>
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
	fileOp?: FileOpRecord
};

export type FileOpRecord = {
	path: string
	status: LocalFileStatus
};

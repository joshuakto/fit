import sha1 from "sha1"

export interface ICommit {
    id: string,
    message: string
    parent: ICommit | null
    log: () => string[];
}

export class Commit implements ICommit {
    readonly id: string
    message: string
    parent: ICommit | null
    constructor(message: string, parent?: ICommit) {
        this.message = message,
        this.id = sha1(message)
        this.parent = parent ?? null
    }
    log() : string[] {
        const histroy: string[] = [];
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        let currentCommit: ICommit | null = this;
        while (currentCommit) {
            histroy.push(currentCommit.id);
            currentCommit = currentCommit.parent
        }
        return histroy
    }
}


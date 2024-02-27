import { DataAdapter, Notice } from "obsidian"

export interface IAdd {
    stageFile: (path: string) => Promise<boolean>
}

export class Add implements IAdd {
    stageLog: string
    da: DataAdapter
    constructor(da: DataAdapter) {
        this.da = da
        this.stageLog = './stage.txt'
    }
    
    async stageFile(path: string) : Promise<boolean> {
        if (await this.da.exists(path)) {
            return true
        }
        new Notice(`An error occured when staging ${path}, check logs for details`)
        throw new Error("Attempting to add non-existent file");
    }
}
import { warn } from "console";
import { Notice, TFile, Vault, base64ToArrayBuffer } from "obsidian";

export interface IVaultOperations {
    vault: Vault
    noticeDuration: number
    deleteFromLocal: (path: string) => Promise<void>
    writeToLocal: (path: string, content: string) => Promise<void>
}

export class VaultOperations implements IVaultOperations {
    vault: Vault
    noticeDuration: number

    constructor(vault: Vault) {
        this.vault = vault
        this.noticeDuration = 10000
    }

    async deleteFromLocal(path: string): Promise<void> {
        // adopted getAbstractFileByPath for mobile compatiability
        // TODO: check whether additional checks needed to validate instance of TFile
        const file = this.vault.getAbstractFileByPath(path)
        if (file) {
            await this.vault.delete(file);
            new Notice(`${path} deleted from local drive.`, this.noticeDuration);
            return
        }
        warn(`Attempting to delete ${path} from local but not found.`)
    }

    async ensureFolderExists(path: string): Promise<void> {
        // extract folder path, return empty string is no folder path is matched (exclude the last /)
        const folderPath = path.match(/^(.*)\//)?.[1] || '';
        if (folderPath != "" && !(this.vault.getFolderByPath(folderPath))) {
            await this.vault.createFolder(folderPath)
        }
    }

    async writeToLocal(path: string, content: string): Promise<void> {
        // adopted getAbstractFileByPath for mobile compatiability
        // temporary fix that works temporarily since path are garanteed to be for files not folders
        // TODO: check whether additional checks needed to validate instance of TFile
        const file = this.vault.getAbstractFileByPath(path) as TFile
        if (file) {
            await this.vault.modifyBinary(file, base64ToArrayBuffer(content))
        } else {
            this.ensureFolderExists(path)
            await this.vault.createBinary(path, base64ToArrayBuffer(content))
        }
        new Notice(`${path} ${file ? 'updated' : 'copied'} to local drive.`, this.noticeDuration);
        return
    }

    async updateLocalFiles(
        addToLocal: {path: string, content: string}[], 
        deleteFromLocal: Array<string>) {
            // Process file additions or updates
            const writeOperations = addToLocal.map(async ({path, content}) => {
                await this.writeToLocal(path, content)
            });
        
            // Process file deletions
            const deletionOperations = deleteFromLocal.map(async (path) => {
                await this.deleteFromLocal(path)
            });
            await Promise.all([...writeOperations, ...deletionOperations]);
    }
}
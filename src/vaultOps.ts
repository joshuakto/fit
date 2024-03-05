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
        const file = this.vault.getAbstractFileByPath(path)
        if (file && file instanceof TFile) {
            await this.vault.delete(file);
            new Notice(`${path} deleted from local drive.`, this.noticeDuration);
            return
        } 
        warn(`Attempting to delete ${path} from local but not successful, file is of type ${typeof file}.`)
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
        // TODO: add capability for creating folder from remote
        const file = this.vault.getAbstractFileByPath(path)
        if (file && file instanceof TFile) {
            await this.vault.modifyBinary(file, base64ToArrayBuffer(content))
        } else if (!file) {
            this.ensureFolderExists(path)
            await this.vault.createBinary(path, base64ToArrayBuffer(content))
        } else {
            throw new Error(`${path} writeToLocal operation unsuccessful, 
            vault abstractFile on ${path} is of type ${typeof file}`);
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
import { warn } from "console";
import { Notice, Vault, base64ToArrayBuffer } from "obsidian";
import { getFileEncoding } from "./utils";

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
        const file = this.vault.getFileByPath(path);
        if (file) {
            await this.vault.delete(file);
            new Notice(`${path} deleted from local drive.`, this.noticeDuration);
            return
        }
        warn(`Attempting to delete ${path} from local but not found.`)
    }

    async writeToLocal(path: string, content: string): Promise<void> {
        const file = this.vault.getFileByPath(path);
        const encoding = getFileEncoding(path)
        const isBinary = encoding === "base64"
        if (file) {
            if (isBinary) {
                await this.vault.modifyBinary(file, base64ToArrayBuffer(content))
            } else {
                await this.vault.modify(file, content)
            }
        } else {
            if (isBinary) {
                await this.vault.createBinary(path, base64ToArrayBuffer(content))
            } else {
                await this.vault.create(path, content)
            }
        }
        new Notice(`${path} ${file ? 'updated' : 'copied'} to local drive.`, this.noticeDuration);
        return
    }

    async updateLocalFiles(
        addToLocal: {path: string, content: string, encoding: string}[], 
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
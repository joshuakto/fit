import { ListedFiles, TFile, TFolder, Vault, base64ToArrayBuffer } from "obsidian";
import { FileOpRecord } from "./fitTypes";
import { conflictResolutionFolder } from "./const";
import { extractDirname } from "./utils";

type FilesFolders = {
    folders: string[]
    files: string[]
}

export interface IVaultOperations {
    vault: Vault
    deleteFromLocal: (path: string) => Promise<FileOpRecord | null>
    writeToLocal: (path: string, content: string) => Promise<FileOpRecord>
    updateLocalFiles: (
        addToLocal: {path: string, content: string}[],
        deleteFromLocal: Array<string>
    ) => Promise<FileOpRecord[]>

    createCopyInDir: (path: string, copyDir: string) => Promise<void>
}

export class VaultOperations implements IVaultOperations {
    vault: Vault

    constructor(vault: Vault) {
        this.vault = vault
    }

    async getTFile(path: string): Promise<TFile | null> {
        const file = this.vault.getAbstractFileByPath(path)
        if (file && file instanceof TFile) {
            return file
        } else {
            // console.error(`Attempting to read ${path} from local drive as TFile but not successful,
            // file is of type ${typeof file}.`)

            return null
        }
    }

    async deleteFromLocal(path: string): Promise<FileOpRecord | null> {
        // adopted getAbstractFileByPath for mobile compatiability
        // use adapter for files in the .obsidian
        // const file = this.vault.getAbstractFileByPath(path)
        const isExists = await this.vault.adapter.exists(path)
        if (!isExists) {
            console.error(`Attempting to delete ${path} from local drive but not successful:
                the file doesn't exists`)

            return null
        }

        await this.vault.adapter.remove(path);

        let dirname = extractDirname(path)
        while (dirname) {
            const { files } = await this.traverseDirectory(dirname)
            if (files.length)
                break

            await this.vault.adapter.rmdir(dirname, true)
            // cutoff last '/'
            dirname = extractDirname(
                dirname.slice(0, dirname.length-1)
            )
        }

        return {path, status: "deleted"}
    }

    // if checking a folder, require including the last / in the path param
    async ensureFolderExists(path: string): Promise<boolean> {
        // extract folder path, return empty string is no folder path is matched (exclude the last /)
        const folderPath = path.match(/^(.*)\//)?.[1] || '';
        if (folderPath == "") {
            return false
            // const folder = this.vault.adapter.exists(folderPath)
            // if (!folder) {
            //     // TODO что если несколько вложенных папок (mkdir -p ....)
            //     await this.vault.adapter.mkdir(folderPath)
            // }
        }
        const parts = folderPath.split('/');
        let currentPath = '';
        for (const part of parts) {
            currentPath += part + '/';
            try {
                const isExists = await this.vault.adapter.exists(currentPath, true)

                if (isExists)
                    continue

                await this.vault.adapter.mkdir(currentPath);
            } catch (e) {
                return false
            }
        }
        return true
    }

    /*
    * content is base64
    */
    async writeToLocal(path: string, content: string): Promise<FileOpRecord> {
        // TODO: add capability for creating folder from remote
        const file = await this.vault.adapter.exists(path)

        // TODO refactor if else
        if (file) {
            await this.vault.adapter.writeBinary(path, base64ToArrayBuffer(content))
            return {path, status: "changed"}
        }
        else {
            await this.ensureFolderExists(path)
            await this.vault.adapter.writeBinary(path, base64ToArrayBuffer(content))
            return {path, status: "created"}
        }
            // throw new Error(`${path}: writeToLocal operation unsuccessful`);
    }

    async updateLocalFiles(
        addToLocal: {path: string, content: string}[],
        deleteFromLocal: Array<string>): Promise<FileOpRecord[]>
    {
        // Process file additions or updates
        const writeOperations = addToLocal.map(async ({path, content}) => {
            return await this.writeToLocal(path, content)
        });

        // Process file deletions
        const deletionOperations = deleteFromLocal.map(async (path) => {
            return await this.deleteFromLocal(path)
        });
        const fileOps = await Promise.all([...writeOperations, ...deletionOperations]);

        return fileOps as FileOpRecord[]
    }

    // TODO хотя нигде не используется, мб удалить надо
    async createCopyInDir(path: string, copyDir = conflictResolutionFolder): Promise<void> {
        const file = await this.vault.adapter.exists(path)
        if (file) {
            const copyPath = copyDir + path

            const copy = await this.vault.adapter.readBinary(path)
            await this.ensureFolderExists(copyPath)

            // const copyFile = await this.vault.adapter.exists(path)
            // if (copyFile) {
                await this.vault.adapter.writeBinary(copyPath, copy)
            // } else if (!copyFile) {
            //     await this.vault.createBinary(copyPath, copy)
            // }
            // } else {
            //     this.vault.adapter.remove(copyFile) // TODO add warning to let user know files in _fit will be overwritten
            //     await this.vault.createBinary(copyPath, copy)
            // }

            await this.vault.adapter.writeBinary(copyPath, copy)
        } else {
            throw new Error(`Attempting to create copy of ${path} from local drive as TFile but not successful,
            file is of type ${typeof file}.`)
        }
    }

    async getAllInObsidian(): Promise<FilesFolders> {
        const rootPath = this.vault.configDir;

        return await this.traverseDirectory(rootPath + "/");
    }

    /*
    * path: normalized folder path (folder1/folder2/, not folder1/folder2)
    */
    async traverseDirectory(path: string): Promise<FilesFolders> {
        const folders: string[] = [ path ];
        const files: string[] = []

        let items: ListedFiles
        try {
            items = await this.vault.adapter.list(path);
        }
        catch (error) {
            return {files, folders}
        }

        for (const folder of items.folders) {
            const iter = await this.traverseDirectory(folder);

            files.push(...iter.files);
            folders.push(...iter.folders);

            let folderPath = folder.startsWith('/') ? folder.slice(1) : folder;
            folderPath = folderPath === "" ? "" : `${folderPath}/`;

            folders.push(folderPath);
        }

        for (const file of items.files) {
            let filePath = file.startsWith('/') ? file.slice(1) : file;

            files.push(filePath);
        }

        return {files, folders}
    }

    async getAllInVault(): Promise<FilesFolders> {
        const all = this.vault.getAllLoadedFiles();

        const folders: string[] = [];
        const files: string[] = [];

        for (let file of all) {
            if (file instanceof TFolder) {
                let path = file.path.startsWith('/') ? file.path.slice(1) : file.path;
                path = path == "" ? "" : `${path}/`
                folders.push(path);
            }
            else if (file instanceof TFile) {
                const path = file.path.startsWith('/') ? file.path.slice(1) : file.path;
                files.push(path);
            }
        }

        // .obsidian folder
        const obsidianItems = await this.getAllInObsidian()
        const [obsidianFiles, obsidianFolders] = [obsidianItems.files, obsidianItems.folders]

        folders.push(...obsidianFolders)
        files.push(...obsidianFiles)

        return {folders, files};
    }

    async getFoldersInVault(): Promise<string[]> {
        const {folders} = await this.getAllInVault()

        return folders;
    }

    async getFilesInVault(): Promise<string[]> {
        const {files} = await this.getAllInVault()

        return files;
    }
}

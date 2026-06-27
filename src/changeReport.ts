import { basicTemplateConflict } from "./const"
import { FileOpRecord, LocalFileStatus } from "./fitTypes"
import { getDiffText, isBinaryFile, removeLineEndingsFromBase64String } from "./utils"

export type ChangeReportRecord = {
    path: string
    status: LocalFileStatus
    isBinary: boolean
    oldContent?: string
    newContent?: string
}

function decodeBase64ToText(content: string): string {
    const binary = atob(removeLineEndingsFromBase64String(content));
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}

export function buildChangeReportText(records: ChangeReportRecord[]): string {
    if (records.length === 0) {
        return ""
    }

    let result = ""
    const templateStart = "start of the: "
    const templateEnd = "end of the: "

    for (let record of records) {
        result += basicTemplateConflict + templateStart + record.path + "\n"

        if (record.status === "created") {
            result += "remote: created\n"
        } else if (record.status === "deleted") {
            result += "remote: deleted\n"
        } else if (record.isBinary) {
            result += "remote: changed binary file\n"
        } else if (record.oldContent !== undefined && record.newContent !== undefined) {
            result += getDiffText(
                record.oldContent,
                decodeBase64ToText(record.newContent)
            )
        } else {
            result += "remote: changed\n"
        }

        result += "\n"
        result += basicTemplateConflict + templateEnd + record.path + "\n"
        result += "\n\n\n"
    }

    return result
}

export function buildAppliedRemoteChangeReport(
    addToLocal: Array<{path: string, content: string}>,
    fileOpsRecord: FileOpRecord[],
    localContent: Record<string, string>,
    basepath: string
): string {
    const newContentByPath = Object.fromEntries(
        addToLocal.map(({path, content}) => [path, content])
    )

    return buildChangeReportText(
        fileOpsRecord.map(fileOp => {
            const relativePath = fileOp.path.replace(basepath, "")
            return {
                ...fileOp,
                isBinary: isBinaryFile(fileOp.path),
                oldContent: localContent[relativePath],
                newContent: newContentByPath[fileOp.path]
            }
        })
    )
}

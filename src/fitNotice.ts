import { Notice } from "obsidian";
import { Fit } from "./fit";

export default class FitNotice {
    fit: Fit
    muted: boolean
    notice: null | Notice
    classes: Array<string>

    constructor(addClasses: Array<string> = [], initialMessage?: string, duration = 0, muted = false) {
        this.muted = muted
        this.classes = ['fit-notice']
        if (initialMessage && !this.muted) {
            this.show(initialMessage, addClasses, duration)
        } else {
            this.classes = [...this.classes, ...addClasses]
        }
    }

    mute(): void {
        this.muted = true
        if (this.notice) {
            this.notice.hide()
        }
    }

    unmute(): void {
        this.muted = false
    }

    show(initialMessage?: string, addClasses: Array<string> = [], duration = 0): void {
        if (!this.notice && !this.muted) {
            const message = (initialMessage && initialMessage.length > 0)? initialMessage : " "
            this.notice = new Notice(message, duration)
            this.notice.noticeEl.addClasses([...this.classes, ...addClasses])
        }
    }

    updateClasses(addClasses: Array<string> = [], removeClasses: Array<string> = []): void {
        if (this.muted) {return}
        this.classes = this.classes.filter(c => !removeClasses.includes(c))
        if (this.notice) {
            this.notice.noticeEl.removeClasses(removeClasses)
            this.notice.noticeEl.addClasses(addClasses)
        }
        this.classes = [...this.classes, ...addClasses]
    }

    // allows error display to override muted
    setMessage(message: string, isError?: boolean): void {
        if (isError) {
            if (!this.notice) {
                this.notice = new Notice(message, 0)
                this.notice.noticeEl.addClasses(['fit-notice', 'error'])
            } else {
                this.notice.setMessage(message)
            }
        } else {
            if (this.notice && !this.muted) {
                this.notice.setMessage(message)
            }
        }
    }

    remove(finalClass?: string, duration = 5000): void {
        if (this.muted) {return}
        this.notice?.noticeEl.removeClasses(this.classes.filter(c => c !== "fit-notice"))
        if (finalClass) {
            this.notice?.noticeEl.addClass(finalClass)
        } else {
            this.notice?.noticeEl.addClass("done")
        }
        setTimeout(() => this.notice?.hide(), duration)
    }

}

import { App, Modal, Setting } from "obsidian";

export class ComputeFileLocalShaModal extends Modal {
	queryFile: string;
	onSubmit: (result: string) => void;

	constructor(app: App, onSubmit: (result: string) => void) {
		super(app);
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const {contentEl} = this;
		contentEl.createEl("h1", { text: "Input the filename you want to compute local Sha for:" });
		new Setting(contentEl)
		.setName("Name")
		.addText((text) =>
			text.onChange((value) => {
			this.queryFile = value
			}));

		new Setting(contentEl)
		.addButton((btn) =>
			btn
			.setButtonText("Submit")
			.setCta()
			.onClick(() => {
				this.close();
				this.onSubmit(this.queryFile);
			}));
	}

	onClose() {
		const {contentEl} = this;
		contentEl.empty();
	}
}

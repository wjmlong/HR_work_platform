type Modal = {
  open: boolean;
  isConnected: boolean;
  showModal: () => void;
  close: () => void;
};
export class DialogStack {
  private stack: Modal[] = [];
  activate(dialog: Modal) {
    const previous = this.stack.at(-1);
    if (previous?.open) previous.close();
    this.stack.push(dialog);
    dialog.showModal();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const index = this.stack.indexOf(dialog),
        wasActive = index === this.stack.length - 1;
      if (index >= 0) this.stack.splice(index, 1);
      if (dialog.open) dialog.close();
      const current = this.stack.at(-1);
      if (wasActive && current?.isConnected && !current.open)
        current.showModal();
    };
  }
}
export const dialogs = new DialogStack();

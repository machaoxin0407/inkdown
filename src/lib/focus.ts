export function modalFocus(node: HTMLElement) {
  const previous = document.activeElement as HTMLElement;
  const elements = () =>
    [...node.querySelectorAll<HTMLElement>('input,button,[tabindex="0"]')].filter(
      (el) => !el.hasAttribute('disabled'),
    );
  queueMicrotask(() => (node.querySelector<HTMLElement>('input') || elements()[0])?.focus());
  const trap = (event: KeyboardEvent) => {
    if (event.key !== 'Tab') return;
    const all = elements(),
      first = all[0],
      last = all[all.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };
  node.addEventListener('keydown', trap);
  return {
    destroy() {
      node.removeEventListener('keydown', trap);
      previous?.focus();
    },
  };
}

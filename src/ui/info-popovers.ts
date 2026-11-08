/** Hints use native popovers for top-layer rendering, Escape and outside dismissal. */
export function initInfoPopovers(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('.section-info')) {
    const popup = document.getElementById(button.getAttribute('popovertarget')!)!;
    button.setAttribute('aria-expanded', 'false');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let openBeforePointer = false;
    const place = () => {
      const anchor = button.getBoundingClientRect();
      const rect = popup.getBoundingClientRect();
      popup.style.left = `${Math.max(8, Math.min(innerWidth - rect.width - 8, anchor.left))}px`;
      const below = anchor.bottom + 8;
      popup.style.top = `${Math.max(8, Math.min(innerHeight - rect.height - 8, below + rect.height <= innerHeight - 8 ? below : anchor.top - rect.height - 8))}px`;
    };
    const show = () => {
      clearTimeout(timer);
      popup.showPopover();
      place();
    };
    const hide = () => {
      clearTimeout(timer);
      popup.hidePopover();
    };
    const hideSoon = () => {
      timer = setTimeout(() => {
        if (document.activeElement !== button) hide();
      }, 120);
    };
    button.addEventListener('pointerenter', (event) => {
      if (event.pointerType !== 'touch') show();
    });
    button.addEventListener('pointerleave', hideSoon);
    button.addEventListener('focus', show);
    button.addEventListener('pointerdown', () => {
      openBeforePointer = popup.matches(':popover-open');
    });
    button.addEventListener('click', (event) => {
      event.preventDefault();
      if (event.detail ? openBeforePointer : popup.matches(':popover-open')) hide();
      else show();
    });
    button.addEventListener('blur', hideSoon);
    popup.addEventListener('pointerenter', () => clearTimeout(timer));
    popup.addEventListener('pointerleave', hideSoon);
    popup.addEventListener('toggle', () => {
      const open = popup.matches(':popover-open');
      button.setAttribute('aria-expanded', String(open));
      if (open) place();
    });
    document.addEventListener(
      'scroll',
      (event) => {
        if (event.target instanceof Node && popup.contains(event.target)) return;
        if (popup.matches(':popover-open') && (button.matches(':hover') || document.activeElement === button))
          place();
        else hide();
      },
      { capture: true, passive: true },
    );
    window.addEventListener('resize', hide);
  }
}

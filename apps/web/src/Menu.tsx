/**
 * Kritva's action menu: a menu button (WAI-ARIA APG pattern) in the design system's style.
 *
 * Keyboard: Enter, Space or Down opens on the first item, Up on the last; Down/Up move; Home/End
 * jump; Enter or Space runs the item; Escape closes and returns focus; Tab closes.
 * The list grows from its trigger with a critically damped spring, or fades under reduced motion.
 */
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { MoreIcon } from "./icons.tsx";

export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Destructive items are set apart and named plainly. */
  destructive?: boolean;
  onSelect: () => void;
}

export function Menu({ label, items, disabled = false }: { label: string; items: MenuItem[]; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const reduced = useReducedMotion();
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (open) itemRefs.current[active]?.focus();
  }, [open, active]);

  const show = (index: number) => {
    setActive(index);
    setOpen(true);
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (["Enter", " ", "ArrowDown"].includes(e.key)) {
      e.preventDefault();
      show(0);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      show(items.length - 1);
    }
  };

  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const last = items.length - 1;
    const keys: Record<string, () => void> = {
      ArrowDown: () => setActive((i) => (i >= last ? 0 : i + 1)),
      ArrowUp: () => setActive((i) => (i <= 0 ? last : i - 1)),
      Home: () => setActive(0),
      End: () => setActive(last),
      Escape: () => close(),
    };
    if (e.key === "Tab") {
      setOpen(false);
      return;
    }
    const run = keys[e.key];
    if (run) {
      e.preventDefault();
      e.stopPropagation();
      run();
    }
  };

  return (
    <div className="menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="icon-button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          if (open) close(false);
          else show(0);
        }}
        onKeyDown={onTriggerKey}
      >
        <MoreIcon />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            id={`${id}-menu`}
            role="menu"
            aria-label={label}
            className="menu-list"
            onKeyDown={onListKey}
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: -2 }}
            transition={{ type: "spring", duration: 0.25, bounce: 0 }}
          >
            {items.map((item, i) => (
              <button
                key={item.id}
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                type="button"
                role="menuitem"
                tabIndex={i === active ? 0 : -1}
                className={`menu-item${item.destructive ? " is-destructive" : ""}`}
                onPointerEnter={() => setActive(i)}
                onClick={(e) => {
                  e.stopPropagation();
                  close();
                  item.onSelect();
                }}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

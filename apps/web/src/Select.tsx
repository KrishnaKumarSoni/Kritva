/**
 * Kritva's select: a select-only combobox (WAI-ARIA APG pattern) in the design system's style,
 * never the browser-native control.
 *
 * Keyboard: Enter, Space, Down or Up opens; Down/Up move; Home/End jump; Enter or Space
 * chooses; Escape closes and returns focus; Tab chooses nothing and closes.
 * The list grows from its trigger with a critically damped spring, or fades under reduced motion.
 */
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { CheckIcon, ChevronIcon } from "./icons.tsx";

export interface SelectOption {
  value: string;
  label: string;
  description?: string | null;
}

interface SelectProps {
  label: string;
  value: string | null;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Shown when nothing is selected. */
  placeholder?: string;
  /** Which edge the list lines up with: the trigger's end (default) or its start, for a trigger on the leading edge. */
  align?: "start" | "end";
}

export function Select({ label, value, options, onChange, disabled = false, placeholder = "Choose…", align = "end" }: SelectProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const id = useId();
  const labelId = `${id}-label`;
  const listId = `${id}-list`;
  const selected = options.find((o) => o.value === value) ?? null;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const openList = (index?: number) => {
    setActive(index ?? Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };
  const choose = (index: number) => {
    const option = options[index];
    if (option) onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!open) {
      if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(e.key)) {
        e.preventDefault();
        openList(e.key === "ArrowUp" ? options.length - 1 : undefined);
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActive((i) => Math.min(options.length - 1, i + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive((i) => Math.max(0, i - 1));
        break;
      case "Home":
        e.preventDefault();
        setActive(0);
        break;
      case "End":
        e.preventDefault();
        setActive(options.length - 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        choose(active);
        break;
      case "Escape":
        e.preventDefault();
        setOpen(false);
        break;
      case "Tab":
        setOpen(false);
        break;
    }
  };

  return (
    <div className="select" ref={rootRef}>
      <span className="select-label" id={labelId}>
        {label}
      </span>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        className="select-trigger"
        aria-labelledby={`${labelId} ${id}-value`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? `${id}-option-${active}` : undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
      >
        <span id={`${id}-value`} className="select-value">
          {selected?.label ?? placeholder}
        </span>
        <ChevronIcon className={`select-chevron${open ? " is-open" : ""}`} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.ul
            id={listId}
            role="listbox"
            aria-labelledby={labelId}
            className={`select-list${align === "start" ? " select-list-start" : ""}`}
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: -2 }}
            transition={{ type: "spring", duration: 0.25, bounce: 0 }}
          >
            {options.map((o, i) => (
              <li
                key={o.value}
                id={`${id}-option-${i}`}
                role="option"
                aria-selected={o.value === value}
                className={`select-option${i === active ? " is-active" : ""}`}
                onPointerEnter={() => setActive(i)}
                onClick={() => choose(i)}
              >
                <span className="select-option-text">
                  <span className="select-option-label">{o.label}</span>
                  {o.description && <span className="select-option-description">{o.description}</span>}
                </span>
                {o.value === value && <CheckIcon className="select-check" />}
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}

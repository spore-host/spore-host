// Form controls: Button, TextField, Select, Checkbox, RadioCards (brief §5).
//
// Every interactive element takes a `control` id, written to data-control.
// The CLI⇄GUI matrix gate (parity/) fails on any rendered control whose id has
// no CLI row and is not listed as app chrome, and on any control without one.
//
// Labels sit above fields, hints below them through aria-describedby, and an
// error adds aria-invalid plus a linked message (SC 1.3.1, 3.3.1, 3.3.2, 4.1.2).
// No placeholder is ever a field's name.
import { h, uid, type Child } from "./dom.js";

export type ButtonVariant = "primary" | "secondary" | "danger" | "link";

export interface ButtonOpts {
  label: string;
  control: string;
  variant?: ButtonVariant;
  onClick?: (e: MouseEvent) => void;
  type?: "button" | "submit";
  disabled?: boolean;
  /** Extra words for screen readers when the visible label repeats, e.g. "Stop" + " rnaseq-align". */
  objectName?: string;
  icon?: Child;
}

/** A button. At most one primary per view (brief §5); that is the page's job, not this function's. */
export function button(o: ButtonOpts): HTMLButtonElement {
  return h(
    "button",
    {
      type: o.type ?? "button",
      class: `btn btn-${o.variant ?? "secondary"}`,
      disabled: o.disabled,
      data: { control: o.control },
      on: o.onClick ? { click: o.onClick } : undefined,
    },
    o.icon,
    o.label,
    o.objectName ? h("span", { class: "visually-hidden" }, ` ${o.objectName}`) : null,
  );
}

/** A link styled as a button, for navigation actions ("Go to instances"). */
export function linkButton(o: { label: string; href: string; control: string; variant?: ButtonVariant }): HTMLAnchorElement {
  return h("a", { href: o.href, class: `btn btn-${o.variant ?? "secondary"}`, data: { control: o.control } }, o.label);
}

interface FieldBase {
  label: string;
  control: string;
  id?: string;
  hint?: string;
  error?: string;
  required?: boolean;
}

/** Wires label, hint and error ids around an input. Returns the wrapper and the ids. */
function fieldShell(o: FieldBase, input: HTMLElement): HTMLDivElement {
  const id = input.id;
  const hintId = o.hint ? `${id}-hint` : undefined;
  const errId = o.error ? `${id}-error` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(" ");
  if (describedBy) input.setAttribute("aria-describedby", describedBy);
  if (o.error) input.setAttribute("aria-invalid", "true");
  if (o.required) input.setAttribute("required", "");
  return h(
    "div",
    { class: `field${o.error ? " field-invalid" : ""}` },
    h("label", { for: id, class: "field-label" }, o.label, o.required ? null : h("span", { class: "field-optional" }, " (optional)")),
    o.hint ? h("p", { id: hintId, class: "field-hint" }, o.hint) : null,
    o.error ? h("p", { id: errId, class: "field-error" }, h("span", { class: "visually-hidden" }, "Error: "), o.error) : null,
    input,
  );
}

export interface TextFieldOpts extends FieldBase {
  value?: string;
  type?: "text" | "number" | "email";
  inputmode?: "text" | "numeric" | "decimal";
  autocomplete?: string;
  /** Visible width in characters, so a short value gets a short field. */
  width?: "short" | "medium" | "full";
  onInput?: (value: string) => void;
}

export function textField(o: TextFieldOpts): HTMLDivElement {
  const input = h("input", {
    id: o.id ?? uid("field"),
    type: o.type ?? "text",
    class: `input input-${o.width ?? "full"}`,
    value: o.value,
    inputmode: o.inputmode,
    autocomplete: o.autocomplete ?? "off",
    spellcheck: "false",
    data: { control: o.control },
    on: o.onInput ? { input: (e: Event) => o.onInput!((e.target as HTMLInputElement).value) } : undefined,
  });
  return fieldShell(o, input);
}

export interface SelectOpts extends FieldBase {
  options: { value: string; label: string }[];
  value?: string;
  onChange?: (value: string) => void;
}

export function select(o: SelectOpts): HTMLDivElement {
  const el = h(
    "select",
    {
      id: o.id ?? uid("select"),
      class: "input select",
      data: { control: o.control },
      on: o.onChange ? { change: (e: Event) => o.onChange!((e.target as HTMLSelectElement).value) } : undefined,
    },
    ...o.options.map((opt) => h("option", { value: opt.value, selected: opt.value === o.value }, opt.label)),
  );
  return fieldShell(o, el);
}

export interface CheckboxOpts {
  label: string;
  control: string;
  id?: string;
  hint?: string;
  checked?: boolean;
  onChange?: (checked: boolean) => void;
}

/** A checkbox with its label to the right and a hint below. The whole row is the 44 px target. */
export function checkbox(o: CheckboxOpts): HTMLDivElement {
  const id = o.id ?? uid("check");
  const hintId = o.hint ? `${id}-hint` : undefined;
  const input = h("input", {
    id,
    type: "checkbox",
    class: "checkbox-input",
    checked: o.checked,
    "aria-describedby": hintId,
    data: { control: o.control },
    on: o.onChange ? { change: (e: Event) => o.onChange!((e.target as HTMLInputElement).checked) } : undefined,
  });
  return h(
    "div",
    { class: "checkbox" },
    input,
    h("label", { for: id, class: "checkbox-label" }, o.label),
    o.hint ? h("p", { id: hintId, class: "field-hint checkbox-hint" }, o.hint) : null,
  );
}

export interface RadioCardOption {
  value: string;
  title: string;
  /** One line of plain specs: "4 processors · 16 GB memory". */
  spec: string;
  /** A price chip, already formatted. */
  price?: string;
  /** Secondary "AWS type: m7i.xlarge". Exempt from the copy lint. */
  awsType?: string;
  /** Why it can't be chosen, shown in words. A disabled card always says why. */
  unavailable?: string;
}

export interface RadioCardsOpts {
  legend: string;
  name: string;
  control: string;
  options: RadioCardOption[];
  value?: string;
  hint?: string;
  onChange?: (value: string) => void;
}

/** A radio group drawn as cards. A fieldset with a legend, so the group has a name (SC 1.3.1). */
export function radioCards(o: RadioCardsOpts): HTMLFieldSetElement {
  const hintId = o.hint ? uid("radio-hint") : undefined;
  return h(
    "fieldset",
    { class: "radio-cards", "aria-describedby": hintId },
    h("legend", { class: "field-label" }, o.legend),
    o.hint ? h("p", { id: hintId, class: "field-hint" }, o.hint) : null,
    h(
      "div",
      { class: "radio-cards-grid" },
      ...o.options.map((opt) => {
        const id = uid(`${o.name}-${opt.value}`);
        const specId = `${id}-spec`;
        return h(
          "div",
          { class: `radio-card${opt.unavailable ? " radio-card-unavailable" : ""}` },
          h("input", {
            type: "radio",
            id,
            name: o.name,
            value: opt.value,
            class: "radio-card-input",
            checked: opt.value === o.value,
            disabled: Boolean(opt.unavailable),
            "aria-describedby": specId,
            data: { control: o.control },
            on: o.onChange ? { change: () => o.onChange!(opt.value) } : undefined,
          }),
          h(
            "label",
            { for: id, class: "radio-card-label" },
            h("span", { class: "radio-card-title" }, opt.title),
            opt.price ? h("span", { class: "chip" }, opt.price) : null,
          ),
          h(
            "p",
            { id: specId, class: "radio-card-spec" },
            opt.spec,
            opt.awsType ? h("span", { class: "radio-card-type", data: { copyExempt: "aws-type" } }, `AWS type: ${opt.awsType}`) : null,
            opt.unavailable ? h("span", { class: "radio-card-why" }, opt.unavailable) : null,
          ),
        );
      }),
    ),
  );
}

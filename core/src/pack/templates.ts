/**
 * The core layout templates and their regions (M2.1b). Every pack defines each one for every
 * aspect class it supports, so the same IR renders under any pack (D39). Pack-specific templates
 * are named `ext_<name>`.
 */
export const CORE_TEMPLATES: Readonly<Record<string, readonly string[]>> = {
  full: ["main"],
  title: ["title", "subtitle"],
  title_body: ["title", "body"],
  split: ["a", "b"],
  lower_third: ["main", "lower_third"],
  end_card: ["main", "footer"],
  captions: ["captions"],
};

export function isExtTemplate(name: string): boolean {
  return /^ext_[a-z0-9_]+$/.test(name);
}

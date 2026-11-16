// "#FFFFFF" in a comment is fine, and so are 12px and 300ms.
interface Reader {
  ms(path: string): number;
  easing(path: string): string;
  px(path: string): number;
}
export function animate(el: HTMLElement, tokens: Reader): void {
  el.style.width = "100%";
  el.style.color = "currentColor";
  el.style.fontSize = `${tokens.px("type.size.body")}px`;
  el.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration: tokens.ms("motion.duration.m"),
    easing: tokens.easing("motion.ease.enter"),
    delay: 0,
  });
}

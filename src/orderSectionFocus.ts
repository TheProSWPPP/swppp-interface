export function focusOrderSection(id: string) {
  const target = document.getElementById(id);
  if (!target) return;
  if (!target.matches("input,textarea,button,select,a[href],[tabindex]")) target.tabIndex = -1;
  target.focus({preventScroll:true});
  target.scrollIntoView({block:"start"});
}

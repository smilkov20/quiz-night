/* Palette drawn from the paper of a quiz night: teams write in blue biro,
   the marker corrects in red pen, the highlighter marks position. Colour
   carries meaning here rather than decorating. */
export const C = {
  page:     "#ECEEE6", // the desk the sheets sit on
  card:     "#FFFFFF", // a fresh answer sheet
  row:      "#F4F6EF", // ruled rows
  rule:     "#CFD5DE", // printed grid line
  ink:      "#15234F", // dried biro — primary text
  inkDim:   "#6C7791", // pencil — secondary text
  biro:     "#2A47C4", // live blue
  biroDim:  "#93A0C6",
  marker:   "#C62B37", // red pen
  correct:  "#1C7A4B", // green pen
  high:     "#F5E45C", // highlighter
  onInk:    "#FFFFFF",
  warnBg:   "#FDEDEE",
} as const;

export const FONT_DISPLAY = "'Bricolage Grotesque','Archivo Black',system-ui,sans-serif";
export const FONT_BODY = "'Public Sans',system-ui,-apple-system,'Segoe UI',sans-serif";
export const FONT_DATA = "'DM Mono',ui-monospace,'SF Mono',Menlo,monospace";

export const pad = (n: number) => String(n).padStart(2, "0");
export const fmtClock = (secs: number) => {
  const s = Math.max(0, Math.ceil(secs));
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
};

// Replaces the clipboard with plain text. Input: {text}.
function main(input) {
  writeClipboardText(input.text);
  return { characters: input.text.length };
}

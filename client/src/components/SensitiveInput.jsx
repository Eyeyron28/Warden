import { useId, useState } from 'react';

/**
 * A text or email field that asks browsers NOT to autofill or suggest values:
 * autocomplete="off", a non-standard `name` that does not look like an email or
 * username field (the usual autofill heuristics key off name/id), no
 * auto-capitalising, auto-correcting or spell-checking, and read-only until the
 * person focuses or touches it - which stops the page-load autofill pass.
 * Typing, pasting and mobile keyboards all work as normal once it is focused.
 *
 * Best effort: browsers may ignore autocomplete="off" for some fields.
 */
function SensitiveInput({ fieldName = 'field', type = 'text', inputRef, onFocus, onPointerDown, ...rest }) {
  const unique = useId().replace(/[^a-z0-9]/gi, '');
  const [armed, setArmed] = useState(false);
  return (
    <input
      {...rest}
      ref={inputRef}
      type={type}
      name={`wd-${fieldName}-${unique}`}
      autoComplete="off"
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      data-lpignore="true"
      data-1p-ignore="true"
      readOnly={!armed}
      onFocus={(event) => {
        setArmed(true);
        onFocus?.(event);
      }}
      onPointerDown={(event) => {
        setArmed(true);
        onPointerDown?.(event);
      }}
    />
  );
}

export default SensitiveInput;

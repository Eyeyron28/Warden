import { useId, useState } from 'react';

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

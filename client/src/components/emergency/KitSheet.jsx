import { createPortal } from 'react-dom';

import { buildKitSheet } from '../../utils/kitSheet.js';
import './kitPrint.css';

/**
 * The printable "Warden Emergency Kit" A4 sheet. It exists only while the Kit screen is open, is invisible on screen,
 * and is the only thing that prints (kitPrint.css hides the rest of the page). It is built by buildKitSheet from the
 * contact's name, the Warden address, the waiting period, the kit and the date, so it cannot contain the owner's
 * password, recovery key or email. Rendered into document.body, so it vanishes with the Kit screen.
 */
function KitSheet({ contactName, address, waitMinutes, kit, qr }) {
  const sheet = buildKitSheet({ contactName, address, waitMinutes, kit });
  return createPortal(
    <div id="kit-print-root" className="kit-sheet" aria-hidden="true">
      <h1 className="kit-sheet-title">{sheet.title}</h1>
      <p className="kit-sheet-line">{sheet.contactLine}</p>
      <p className="kit-sheet-line">
        Warden address: <strong>{sheet.address}</strong>
      </p>
      <p className="kit-sheet-line">{sheet.waitText}</p>

      <h2 className="kit-sheet-h2">What to do</h2>
      <ol className="kit-sheet-steps">
        {sheet.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>

      <h2 className="kit-sheet-h2">Your kit code</h2>
      <div className="kit-sheet-kit">
        <div className="kit-sheet-code">
          {sheet.kitRows.map((row) => (
            <div key={row.join('-')}>{row.join('  ')}</div>
          ))}
        </div>
        {qr && <img className="kit-sheet-qr" src={qr} alt="" />}
      </div>

      <p className="kit-sheet-private">{sheet.privacyLine}</p>
      <p className="kit-sheet-date">{sheet.dateLine}</p>
    </div>,
    document.body
  );
}

export default KitSheet;

import { Suspense, lazy } from 'react';
import { FolderSimple } from '@phosphor-icons/react';

import { folderColorVar } from '../utils/folderStyle.js';

// The other icons are a separate chunk (see FolderGlyphIcons.jsx); the plain folder, which most folders are, is drawn right here.
const StyledIcon = lazy(() => import('./FolderGlyphIcons.jsx'));

/**
 * A folder's icon in its colour. With no icon it draws the plain folder in whatever colour the surrounding CSS gives it (the
 * default look every older folder keeps); a colour alone tints that plain folder.
 */
function FolderGlyph({ icon, color, size = 18, weight = 'fill', className = '' }) {
  const tint = folderColorVar(color);
  const style = tint ? { color: tint } : undefined;
  const plain = <FolderSimple size={size} weight={weight} className={className} style={style} aria-hidden="true" />;
  if (!icon || icon === 'folder') return plain;
  return (
    <Suspense fallback={plain}>
      <StyledIcon icon={icon} size={size} weight={weight} className={className} style={style} />
    </Suspense>
  );
}

export default FolderGlyph;

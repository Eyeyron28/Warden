import { Suspense, lazy } from 'react';
import { FolderSimple } from '@phosphor-icons/react';

import { folderColorVar } from '../utils/folderStyle.js';

const StyledIcon = lazy(() => import('./FolderGlyphIcons.jsx'));

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

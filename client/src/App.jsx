import { Routes, Route, Navigate } from 'react-router-dom';

import LockScreen from './pages/LockScreen.jsx';
import VaultShell from './pages/VaultShell.jsx';

function App() {
  return (
    <Routes>
      <Route path="/" element={<LockScreen />} />
      <Route path="/vault" element={<VaultShell />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;

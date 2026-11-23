import { useEffect, useState } from 'react';

/** CSS logical pixels: respects OS display scaling and browser zoom alike. */
export function useCompactLayout() {
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 1050px)').matches);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1050px)');
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return compact;
}

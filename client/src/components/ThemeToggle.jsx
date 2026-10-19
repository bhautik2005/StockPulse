import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';

import { cn } from '../lib/utils.js';
import { Button } from './ui/Button.jsx';

const STORAGE_KEY = 'stockpulse-theme';

/**
 * Dark by default -- an operations console is often left open on a wall
 * display -- with the choice remembered per browser. The initial class is set
 * by an inline script in index.html so there is no flash of the wrong theme.
 */
export function ThemeToggle({ className }) {
  const [theme, setTheme] = useState(() => {
    if (typeof document === 'undefined') return 'dark';
    return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
  });

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* storage unavailable (private mode): the toggle still works per session */
    }
  }, [theme]);

  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn(className)}
      onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
    >
      {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  );
}
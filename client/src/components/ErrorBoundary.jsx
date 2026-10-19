import { Component } from 'react';
import { RotateCcw, TriangleAlert } from 'lucide-react';

import { Button } from './ui/Button.jsx';

/**
 * Keeps one broken page from taking the console with it.
 *
 * A render error anywhere below this boundary -- a field the API did not send,
 * a chart with unexpected data -- shows a recoverable card instead of a blank
 * screen, and the navigation stays usable so the user can move on.
 */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Console rather than a silent catch: this is a bug, and it should be visible
    // in development with the component stack attached.
    console.error('Unhandled render error', error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="flex min-h-[50vh] items-center justify-center p-6">
        <div className="flex max-w-lg flex-col items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-6 text-center">
          <TriangleAlert className="h-6 w-6 text-destructive" aria-hidden="true" />
          <h2 className="text-sm font-semibold">This page failed to render</h2>
          <p className="text-xs text-muted-foreground">
            {this.state.error.message ?? 'Unexpected error'}
          </p>
          <p className="text-2xs text-muted-foreground">
            The rest of the console still works. Use the navigation to continue, or retry this page.
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => this.setState({ error: null })}>
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              Try again
            </Button>
            <Button size="sm" variant="ghost" onClick={() => window.location.assign('/')}>
              Back to start
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
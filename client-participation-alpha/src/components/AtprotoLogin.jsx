import React, { useState, useEffect } from 'react';
import { getOAuthClient, ensureConsistentOrigin } from '../lib/atproto-oauth';

export default function AtprotoLogin({ conversation_id, s }) {
  const [handle, setHandle] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    ensureConsistentOrigin();
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const trimmed = handle.trim();
    if (!trimmed || isProcessing) return;

    setError('');
    setIsProcessing(true);

    try {
      // Store the conversation to return to after OAuth
      sessionStorage.setItem('return_conversation_id', conversation_id);

      const client = getOAuthClient();
      await client.signIn(trimmed);
      // Browser will redirect to the authorization server
    } catch (err) {
      setIsProcessing(false);
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('network') || message.includes('fetch')) {
        setError('Unable to connect. Please check your internet connection.');
      } else {
        setError(message || 'Failed to start sign-in. Please check your handle and try again.');
      }
    }
  };

  return (
    <div className="atproto-login">
      <h2>{s?.loginHeader || 'Sign in to participate'}</h2>
      <p className="atproto-login-desc">
        {s?.loginDescription || 'This conversation requires you to sign in with your atproto identity.'}
      </p>
      <form onSubmit={handleSubmit} className="atproto-login-form">
        <input
          type="text"
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          placeholder="Enter your atproto handle"
          disabled={isProcessing}
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="username"
          spellCheck="false"
        />
        <button type="submit" disabled={isProcessing || !handle.trim()}>
          {isProcessing ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
      {error && <p className="atproto-login-error">{error}</p>}
    </div>
  );
}

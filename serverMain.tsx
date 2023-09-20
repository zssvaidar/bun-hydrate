// serverMain.tsx
import React from 'react';
import { App } from './main';

export const ServerApp = async () => {
  // simulate some async work
  await new Promise(resolve => setTimeout(resolve, 200));

  return <App />;
};
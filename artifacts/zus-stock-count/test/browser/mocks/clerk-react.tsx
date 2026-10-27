import type { ReactNode } from 'react';

export function ClerkProvider({ children }: { children: ReactNode }) {
  return children;
}

export function Show({ when, children }: { when: 'signed-in' | 'signed-out'; children: ReactNode }) {
  return when === 'signed-in' ? children : null;
}

export function SignIn() {
  return null;
}

export function SignUp() {
  return null;
}

export function UserProfile() {
  return null;
}

export function useClerk() {
  return { signOut: async () => undefined };
}

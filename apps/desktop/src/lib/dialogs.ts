import { create } from "zustand";

export type ConflictChoice = "mine" | "theirs" | "cancel";

interface ConflictRequest {
  title: string;
  mine: string;
  theirs: string;
  resolve(choice: ConflictChoice): void;
}

/** The conflict dialog shown by <ConflictDialog/> (one at a time). */
export const useConflict = create<{ pending?: ConflictRequest }>(() => ({}));

/** Asks the user how to resolve a save conflict, showing both versions. */
export function askConflict(title: string, mine: string, theirs: string): Promise<ConflictChoice> {
  return new Promise((resolve) =>
    useConflict.setState({
      pending: {
        title,
        mine,
        theirs,
        resolve: (choice) => {
          useConflict.setState({ pending: undefined });
          resolve(choice);
        },
      },
    }),
  );
}

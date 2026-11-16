/** The category to write to doesn't exist (created by the setup wizard, not here). */
export class CategoryMissingError extends Error {
    constructor(name: string) {
        super(`Category "${name}" does not exist`);
        this.name = 'CategoryMissingError';
    }
}

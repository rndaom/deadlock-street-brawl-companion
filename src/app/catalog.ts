import publicCatalog from '../../data/public-catalog.json';
import type { Catalog } from '../shared/types';

/** Public definitions stay separate from synthetic model fixtures and participant state. */
export const APP_CATALOG = publicCatalog as Catalog;

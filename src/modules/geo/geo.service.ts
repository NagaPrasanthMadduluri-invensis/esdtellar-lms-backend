import { Injectable, NotFoundException } from '@nestjs/common';
import { City, Country, State } from 'country-state-city';

/**
 * Countries and their cities, for the branch-location picker.
 *
 * Backed by `country-state-city`, installed on the SERVER ONLY and
 * deliberately not in the browser bundle — it unpacks to ~17 MB, and shipping
 * a city database to every page load to fill one dropdown on one admin screen
 * would be the worst trade in the codebase. The client asks for the one
 * country it needs and gets a few thousand names.
 *
 * No database and no organization scope: this is reference data identical for
 * every caller, which is why it is a service with no repository (§3) — there
 * is nothing to query.
 */
@Injectable()
export class GeoService {
  /** Every country, alphabetical, with its flag for the dropdown. */
  countries() {
    return {
      countries: Country.getAllCountries()
        .map((c) => ({ code: c.isoCode, name: c.name, flag: c.flag }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  /**
   * Every city in a country, with the state it sits in.
   *
   * The state is carried for DISPLAY — Indian city names repeat across states
   * often enough that "Hyderabad, Telangana" is the only way to tell an admin
   * which one they picked. It is NOT part of the stored value:
   * `users.location` holds the city name alone, because that is what every
   * existing report groups by (see `0031`).
   *
   * De-duplicated by name: the source lists some cities once per district, and
   * a dropdown with "Bengaluru" four times is unusable.
   */
  cities(countryCode: string) {
    const code = countryCode.toUpperCase();
    const country = Country.getCountryByCode(code);
    if (!country) {
      throw new NotFoundException(`Unknown country code "${countryCode}"`);
    }

    const states = new Map(
      State.getStatesOfCountry(code).map((s) => [s.isoCode, s.name]),
    );

    const seen = new Set<string>();
    const cities: { name: string; state: string | null }[] = [];
    for (const c of City.getCitiesOfCountry(code) ?? []) {
      const key = c.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      cities.push({ name: c.name, state: states.get(c.stateCode) ?? null });
    }
    cities.sort((a, b) => a.name.localeCompare(b.name));

    return { country: { code, name: country.name }, cities };
  }
}

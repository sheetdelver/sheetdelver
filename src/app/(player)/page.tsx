import MainPage from '@client/ui/main/MainPage';

/**
 * Root Server Component for SheetDelver.
 * Decoupled from backend internals by using API-based configuration checks.
 */
export default async function Page() {
    return <MainPage initialUrl="" />;
}
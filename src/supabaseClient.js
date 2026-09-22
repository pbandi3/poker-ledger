// Shared Supabase client for the optional "share for payment" feature.
// This key is the publishable/anon key — safe to ship in client code by
// design. Access is scoped entirely by the RLS policies on the project
// (see supabase/schema.sql), not by keeping this value secret.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://pbozaovvgbcwwayzbqej.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_auHguxYsuQJhEEEe9j4Pxw_4vZtJ8J3';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

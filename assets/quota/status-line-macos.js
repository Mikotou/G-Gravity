/* Apple's JavaScript for Automation runs this local status-line callback. */
ObjC.import('Foundation');

function quotaSnapshot(state) {
  if (!state || !state.quota || typeof state.quota !== 'object') return null;
  const quota = Object.create(null);
  for (const name of Object.keys(state.quota)) {
    const source = state.quota[name];
    if (!source || typeof source !== 'object') continue;
    const bucket = Object.create(null);
    if (Number.isFinite(source.remaining_fraction) && source.remaining_fraction >= 0 && source.remaining_fraction <= 1)
      bucket.remaining_fraction = source.remaining_fraction;
    if (Number.isFinite(source.remaining_amount) && source.remaining_amount >= 0)
      bucket.remaining_amount = source.remaining_amount;
    if (source.disabled === true) bucket.disabled = true;
    if (Object.keys(bucket).length === 0) continue;
    if (typeof source.reset_time === 'string') bucket.reset_time = source.reset_time;
    if (Number.isFinite(source.reset_in_seconds) && source.reset_in_seconds >= 0) bucket.reset_in_seconds = source.reset_in_seconds;
    quota[name] = bucket;
  }
  if (Object.keys(quota).length === 0) return null;
  const record = { quota };
  if (typeof state.plan_tier === 'string') record.plan = state.plan_tier;
  return record;
}

function run(argv) {
  const target = argv[0];
  const files = $.NSFileManager.defaultManager;
  if (files.fileExistsAtPath(target)) return 'Gravity';
  const input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  let state;
  try {
    const text = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(input, $.NSUTF8StringEncoding));
    state = JSON.parse(text);
  } catch (_) { return 'Gravity'; } // An interrupted callback has no reading to publish.
  const record = quotaSnapshot(state);
  if (!record) return 'Gravity';
  const staged = target + '.' + ObjC.unwrap($.NSUUID.UUID.UUIDString) + '.tmp';
  const data = $(JSON.stringify(record)).dataUsingEncoding($.NSUTF8StringEncoding);
  try {
    if (data.writeToFileAtomically(staged, true)) {
      // Linking is atomic and cannot replace a valid reading published by another callback.
      files.linkItemAtPathToPathError(staged, target, null);
    }
  } finally {
    files.removeItemAtPathError(staged, null);
  }
  return 'Gravity';
}

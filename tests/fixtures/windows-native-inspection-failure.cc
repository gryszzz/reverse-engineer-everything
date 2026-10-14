// Only the separate conformance artifact uses this translation unit. The
// shipped addon always compiles filesystem.cc directly, without interposition.
#include "../../native/windows/src/authority.hpp"
#include <atomic>

static BOOL inspectionDisposition(HANDLE handle, FILE_INFO_BY_HANDLE_CLASS kind,
                                  LPVOID value, DWORD size) {
  // A real NTFS probe is created normally. Fail its first disposition call so
  // the verifier can observe ownership after failure, independently of host
  // filter drivers or the intermittent error reported in issue #1701.
  static std::atomic_flag failed = ATOMIC_FLAG_INIT;
  if (kind == FileDispositionInfo && !failed.test_and_set()) {
    SetLastError(ERROR_ACCESS_DENIED);
    return FALSE;
  }
  return SetFileInformationByHandle(handle, kind, value, size);
}

#define SetFileInformationByHandle inspectionDisposition
#include "../../native/windows/src/filesystem.cc"

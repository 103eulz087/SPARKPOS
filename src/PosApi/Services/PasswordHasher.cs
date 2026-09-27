using System.Security.Cryptography;
using System.Text;

namespace PosApi.Services;

public static class PasswordHasher
{
    public static string NewSalt() => Convert.ToHexString(RandomNumberGenerator.GetBytes(16));
    public static string Hash(string salt, string password) =>
        Convert.ToBase64String(SHA256.HashData(Encoding.UTF8.GetBytes(salt + password)));
    public static bool Verify(string salt, string password, string hash) =>
        CryptographicOperations.FixedTimeEquals(
            Encoding.UTF8.GetBytes(Hash(salt, password)), Encoding.UTF8.GetBytes(hash));
}
